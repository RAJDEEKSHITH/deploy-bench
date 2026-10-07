import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  branchHeads,
  githubIntegrations,
  outboxMessages,
  projects,
  webhookDeliveries,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { decrypt, verifyGithubSignature } from "../../utils/crypto.util.js";

/* -------------------------------------------------------------------------- */
/* Types + constants                                                          */
/* -------------------------------------------------------------------------- */

type WebhookStatus = (typeof webhookDeliveries.$inferSelect)["status"];

/** Statuses a worker may (re)process. `queued` is set once the outbox publishes. */
const CLAIMABLE_STATUSES: WebhookStatus[] = ["received", "queued", "failed"];

const BRANCH_REF_PREFIX = "refs/heads/";
const MAX_BRANCH_LENGTH = 128; // branch_heads.branch
const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

type GithubPush = {
  ref: string;
  before: string;
  after: string;
  forced: boolean;
  deleted: boolean;
};

export type IngestGithubWebhookInput = {
  projectId: string;
  githubDeliveryId: string | undefined;
  eventName: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
};

export type IngestGithubWebhookResult =
  | { status: "accepted"; webhookDeliveryId: string; duplicate: boolean }
  | { status: "ignored"; reason: "unsupported_event" };

/* -------------------------------------------------------------------------- */
/* Ingest (HTTP request path)                                                 */
/* -------------------------------------------------------------------------- */

const getWebhookIntegration = async (projectId: string) => {
  const [integration] = await db
    .select({
      id: githubIntegrations.id,
      enabled: githubIntegrations.enabled,
      webhookSecretCiphertext: githubIntegrations.webhookSecretCiphertext,
      webhookSecretIv: githubIntegrations.webhookSecretIv,
      webhookSecretAuthTag: githubIntegrations.webhookSecretAuthTag,
    })
    .from(githubIntegrations)
    .where(eq(githubIntegrations.projectId, projectId))
    .limit(1);

  if (!integration || !integration.enabled) {
    throw new AppError("Webhook endpoint not found", 404);
  }

  return integration;
};

const decryptWebhookSecret = (
  integration: Awaited<ReturnType<typeof getWebhookIntegration>>,
): string => {
  try {
    return decrypt({
      ciphertext: integration.webhookSecretCiphertext,
      iv: integration.webhookSecretIv,
      authTag: integration.webhookSecretAuthTag,
    });
  } catch {
    throw new AppError("Webhook verification configuration is invalid", 500);
  }
};

const parsePayload = (rawBody: Buffer): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError("Invalid webhook JSON payload", 400);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("Invalid webhook payload", 400);
  }

  return parsed as Record<string, unknown>;
};

const requireString = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new AppError(`Invalid webhook ${field}`, 400);
  }
  return value;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new AppError(`Invalid webhook ${field}`, 400);
  return value;
};

const parsePush = (payload: Record<string, unknown>): GithubPush => ({
  ref: requireString(payload.ref, "ref", 512),
  before: requireString(payload.before, "before SHA", 256),
  after: requireString(payload.after, "after SHA", 256),
  forced: requireBoolean(payload.forced, "forced field"),
  deleted: requireBoolean(payload.deleted, "deleted field"),
});

export const ingestGithubWebhook = async ({
  projectId,
  githubDeliveryId,
  eventName,
  signature,
  rawBody,
}: IngestGithubWebhookInput): Promise<IngestGithubWebhookResult> => {
  if (rawBody.length === 0) throw new AppError("Webhook request body is empty", 400);

  if (!githubDeliveryId || githubDeliveryId.length > 128) {
    throw new AppError("Invalid GitHub delivery ID", 400);
  }

  if (!eventName || eventName.length > 64) {
    throw new AppError("Invalid GitHub event", 400);
  }

  const integration = await getWebhookIntegration(projectId);
  const webhookSecret = decryptWebhookSecret(integration);

  if (!verifyGithubSignature({ rawBody, secret: webhookSecret, signature })) {
    throw new AppError("Invalid webhook signature", 401);
  }

  // The schema is push-specific: acknowledge other signed events (e.g. ping).
  if (eventName !== "push") {
    return { status: "ignored", reason: "unsupported_event" };
  }

  const payload = parsePayload(rawBody);
  const push = parsePush(payload);

  return db.transaction(async (tx): Promise<IngestGithubWebhookResult> => {
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({
        projectId,
        githubIntegrationId: integration.id,
        githubDeliveryId,
        status: "received",
        eventName,
        ref: push.ref,
        isForced: push.forced,
        isDeleted: push.deleted,
        isSignatureValid: true,
        payload,
        beforeSha: push.before.toLowerCase(),
        afterSha: push.after.toLowerCase(),
      })
      .onConflictDoNothing({
        target: [webhookDeliveries.githubIntegrationId, webhookDeliveries.githubDeliveryId],
      })
      .returning({ id: webhookDeliveries.id });

    // GitHub redelivery / duplicate delivery.
    if (!delivery) {
      const [existing] = await tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.githubIntegrationId, integration.id),
            eq(webhookDeliveries.githubDeliveryId, githubDeliveryId),
          ),
        )
        .limit(1);

      if (!existing) throw new AppError("Failed to resolve webhook delivery", 500);

      return { status: "accepted", webhookDeliveryId: existing.id, duplicate: true };
    }

    await tx.insert(outboxMessages).values({
      messageType: "github.webhook.received",
      aggregateType: "webhook_delivery",
      aggregateId: delivery.id,
      dedupeKey: `github:webhook:${integration.id}:${githubDeliveryId}`,
      payload: { webhookDeliveryId: delivery.id },
      queueName: "webhook",
    });

    return { status: "accepted", webhookDeliveryId: delivery.id, duplicate: false };
  });
};

/* -------------------------------------------------------------------------- */
/* Processing (worker path)                                                   */
/* -------------------------------------------------------------------------- */

const getWebhookDelivery = async (webhookDeliveryId: string) => {
  const [delivery] = await db
    .select({
      id: webhookDeliveries.id,
      // From the joins, so they are non-null (the delivery columns are nullable).
      projectId: projects.id,
      githubIntegrationId: githubIntegrations.id,
      integrationRepositoryFullName: githubIntegrations.repositoryFullName,
      repositoryUrl: projects.repositoryUrl,
      pipelinePath: projects.pipelinePath,
      eventName: webhookDeliveries.eventName,
      status: webhookDeliveries.status,
      ref: webhookDeliveries.ref,
      beforeSha: webhookDeliveries.beforeSha,
      afterSha: webhookDeliveries.afterSha,
      isDeleted: webhookDeliveries.isDeleted,
      isSignatureValid: webhookDeliveries.isSignatureValid,
      payload: webhookDeliveries.payload,
      receivedAt: webhookDeliveries.receivedAt,
    })
    .from(webhookDeliveries)
    .innerJoin(githubIntegrations, eq(webhookDeliveries.githubIntegrationId, githubIntegrations.id))
    .innerJoin(projects, eq(webhookDeliveries.projectId, projects.id))
    .where(eq(webhookDeliveries.id, webhookDeliveryId))
    .limit(1);

  return delivery;
};

type StoredDelivery = NonNullable<Awaited<ReturnType<typeof getWebhookDelivery>>>;

const getPayloadRepositoryFullName = (payload: Record<string, unknown>): string => {
  const repository = payload.repository;

  if (repository === null || typeof repository !== "object" || Array.isArray(repository)) {
    throw new AppError("Webhook repository data is invalid", 400);
  }

  const fullName = (repository as { full_name?: unknown }).full_name;

  if (typeof fullName !== "string" || fullName.length === 0) {
    throw new AppError("Webhook repository name is invalid", 400);
  }

  return fullName;
};

/**
 * Validates a stored delivery.
 * Returns the branch update to apply, null when the delivery should be ignored
 * (not a branch push), or throws AppError for malformed data.
 */
const resolveBranchUpdate = (
  delivery: StoredDelivery,
): { branch: string; commitSha: string } | null => {
  if (!delivery.isSignatureValid) {
    throw new AppError("Unsigned webhook cannot be processed", 400);
  }

  if (delivery.eventName !== "push") return null;

  // Tag pushes are not branch heads.
  if (delivery.ref === null || !delivery.ref.startsWith(BRANCH_REF_PREFIX)) return null;

  const branch = delivery.ref.slice(BRANCH_REF_PREFIX.length);

  if (branch.length === 0 || branch.length > MAX_BRANCH_LENGTH) {
    throw new AppError("Invalid webhook branch", 400);
  }

  if (!COMMIT_SHA_PATTERN.test(delivery.beforeSha) || !COMMIT_SHA_PATTERN.test(delivery.afterSha)) {
    throw new AppError("Invalid webhook commit SHA", 400);
  }

  const payloadRepository = getPayloadRepositoryFullName(delivery.payload);

  if (payloadRepository.toLowerCase() !== delivery.integrationRepositoryFullName.toLowerCase()) {
    throw new AppError("Webhook repository does not match project integration", 400);
  }

  // For a deleted branch GitHub sends an all-zero `after` SHA. It can never
  // equal a run's commit, so the deployment gate fails closed.
  return { branch, commitSha: delivery.afterSha.toLowerCase() };
};

const markDeliveryIgnored = async (webhookDeliveryId: string): Promise<void> => {
  const now = new Date();

  await db
    .update(webhookDeliveries)
    .set({ status: "ignored", processedAt: now, nextAttemptAt: null, lastError: null, updatedAt: now })
    .where(
      and(
        eq(webhookDeliveries.id, webhookDeliveryId),
        inArray(webhookDeliveries.status, CLAIMABLE_STATUSES),
      ),
    );
};

/** Runs outside the work transaction, so the attempt is counted even after a rollback. */
const markDeliveryFailed = async (webhookDeliveryId: string, error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : "Webhook processing failed";
  const now = new Date();

  await db
    .update(webhookDeliveries)
    .set({
      status: "failed",
      lastError: message.slice(0, 2_000),
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.id, webhookDeliveryId),
        inArray(webhookDeliveries.status, CLAIMABLE_STATUSES),
      ),
    );
};

/**
 * Stage 11: apply a push delivery to branch_heads. Idempotent.
 *
 * - The claim UPDATE and the branch_heads upsert are one transaction, so a
 *   duplicate BullMQ job blocks on the row lock, then sees `processed` and no-ops.
 * - branch_heads only moves forward (by receivedAt), so a late or redelivered
 *   older push can never overwrite a newer head.
 * - AppErrors with 4xx are permanent: have the BullMQ worker convert them to
 *   UnrecoverableError so they are not retried.
 */
export const processGithubWebhookDelivery = async (webhookDeliveryId: string): Promise<void> => {
  const delivery = await getWebhookDelivery(webhookDeliveryId);

  // Project/integration deleted after the message was created.
  if (!delivery) return;

  if (delivery.status === "processed" || delivery.status === "ignored") return;

  try {
    const update = resolveBranchUpdate(delivery);

    if (!update) {
      await markDeliveryIgnored(delivery.id);
      return;
    }

    await db.transaction(async (tx) => {
      const now = new Date();

      const [claimed] = await tx
        .update(webhookDeliveries)
        .set({
          status: "processed",
          processedAt: now,
          nextAttemptAt: null,
          lastError: null,
          attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(webhookDeliveries.id, delivery.id),
            inArray(webhookDeliveries.status, CLAIMABLE_STATUSES),
          ),
        )
        .returning({ id: webhookDeliveries.id });

      // Another worker already finished this delivery.
      if (!claimed) return;

      await tx
        .insert(branchHeads)
        .values({
          projectId: delivery.projectId,
          branch: update.branch,
          commitSha: update.commitSha,
          isDeleted: delivery.isDeleted,
          sourceWebhookDeliveryId: delivery.id,
          lastObservedAt: delivery.receivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [branchHeads.projectId, branchHeads.branch],
          set: {
            commitSha: update.commitSha,
            isDeleted: delivery.isDeleted,
            sourceWebhookDeliveryId: delivery.id,
            lastObservedAt: delivery.receivedAt,
            updatedAt: now,
          },
          // Never let an older delivery overwrite a newer branch head.
          setWhere: lte(branchHeads.lastObservedAt, delivery.receivedAt),
        });
    });
  } catch (error) {
    // The transaction has rolled back; record the failure separately.
    await markDeliveryFailed(delivery.id, error);
    throw error;
  }
};