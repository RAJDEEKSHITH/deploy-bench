import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { pipelineVersions, runs, webhookDeliveries } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";

const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BRANCH_LENGTH = 255;

type RunTrigger = (typeof runs.$inferInsert)["trigger"];

export type CreateRunInput = {
  projectId: string;
  pipelineVersionId: string;
  commitSha: string;
  branch: string;
  trigger: RunTrigger;
  webhookDeliveryId?: string | undefined;
};

export type CreateRunResult = {
  runId: string;
  projectId: string;
  pipelineVersionId: string;
  commitSha: string;
  branch: string;
  status: "queued";
  trigger: RunTrigger;
  webhookDeliveryId: string | null;
};

const normalizeCommitSha = (commitSha: string): string => {
  const normalized = commitSha.toLowerCase();

  if (!COMMIT_SHA_PATTERN.test(normalized)) {
    throw new AppError("Invalid run commit SHA", 400);
  }

  return normalized;
};

const validateBranch = (branch: string): string => {
  if (branch.length === 0 || branch.length > MAX_BRANCH_LENGTH) {
    throw new AppError("Invalid run branch", 400);
  }

  if (/\p{Cc}/u.test(branch)) {
    throw new AppError("Invalid run branch", 400);
  }

  return branch;
};

const getPipelineVersion = async (
  projectId: string,
  pipelineVersionId: string,
  commitSha: string,
) => {
  const [pipelineVersion] = await db
    .select({
      id: pipelineVersions.id,
      projectId: pipelineVersions.projectId,
      commitSha: pipelineVersions.commitSha,
    })
    .from(pipelineVersions)
    .where(
      and(
        eq(pipelineVersions.id, pipelineVersionId),
        eq(pipelineVersions.projectId, projectId),
        eq(pipelineVersions.commitSha, commitSha),
      ),
    )
    .limit(1);

  return pipelineVersion;
};

const getExistingRunByWebhookDelivery = async (
  webhookDeliveryId: string,
) => {
  const [run] = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      pipelineVersionId: runs.pipelineVersionId,
      commitSha: runs.commitSha,
      branch: runs.branch,
      status: runs.status,
      trigger: runs.trigger,
      webhookDeliveryId: runs.webhookDeliveryId,
    })
    .from(runs)
    .where(eq(runs.webhookDeliveryId, webhookDeliveryId))
    .limit(1);

  return run;
};

export const createRun = async ({
  projectId,
  pipelineVersionId,
  commitSha: rawCommitSha,
  branch: rawBranch,
  trigger,
  webhookDeliveryId,
}: CreateRunInput): Promise<CreateRunResult> => {
  const commitSha = normalizeCommitSha(rawCommitSha);
  const branch = validateBranch(rawBranch);

  /*
   * The run must reference the pipeline version for the same:
   *
   * project + commit
   *
   * This prevents accidentally creating:
   *
   * project A + commit X + pipeline from project B
   */
  const pipelineVersion = await getPipelineVersion(
    projectId,
    pipelineVersionId,
    commitSha,
  );

  if (!pipelineVersion) {
    throw new AppError(
      "Pipeline version does not belong to this project and commit",
      400,
    );
  }

  /*
   * A push delivery can only create one run.
   *
   * runs.webhook_delivery_id has a unique index in the frozen schema.
   * This makes webhook redelivery safe.
   */
  if (webhookDeliveryId) {
    const [delivery] = await db
      .select({
        id: webhookDeliveries.id,
        projectId: webhookDeliveries.projectId,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, webhookDeliveryId),
          eq(webhookDeliveries.projectId, projectId),
        ),
      )
      .limit(1);

    if (!delivery) {
      throw new AppError(
        "Webhook delivery does not belong to this project",
        400,
      );
    }
  }

  const [inserted] = await db
    .insert(runs)
    .values({
      projectId,
      pipelineVersionId,
      webhookDeliveryId: webhookDeliveryId ?? null,
      commitSha,
      branch,
      status: "queued",
      trigger,
    })
    .onConflictDoNothing({
      target: runs.webhookDeliveryId,
    })
    .returning({
      id: runs.id,
      projectId: runs.projectId,
      pipelineVersionId: runs.pipelineVersionId,
      commitSha: runs.commitSha,
      branch: runs.branch,
      status: runs.status,
      trigger: runs.trigger,
      webhookDeliveryId: runs.webhookDeliveryId,
    });

  if (inserted) {
    return {
      runId: inserted.id,
      projectId: inserted.projectId,
      pipelineVersionId: inserted.pipelineVersionId!,
      commitSha: inserted.commitSha,
      branch: inserted.branch,
      status: "queued",
      trigger: inserted.trigger,
      webhookDeliveryId: inserted.webhookDeliveryId,
    };
  }

  /*
   * Conflict means another worker already created the run
   * for this webhook delivery.
   */
  if (webhookDeliveryId) {
    const existing = await getExistingRunByWebhookDelivery(webhookDeliveryId);

    if (!existing) {
      throw new AppError(
        "Run could not be resolved after conflict",
        500,
      );
    }

    return {
      runId: existing.id,
      projectId: existing.projectId,
      pipelineVersionId: existing.pipelineVersionId!,
      commitSha: existing.commitSha,
      branch: existing.branch,
      status: existing.status as "queued",
      trigger: existing.trigger,
      webhookDeliveryId: existing.webhookDeliveryId,
    };
  }

  throw new AppError("Run could not be created", 500);
};