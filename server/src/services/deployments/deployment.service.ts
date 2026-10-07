import {
  and,
  desc,
  eq,
  gt,
  inArray,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  artifacts,
  containerImages,
  deployments,
  environments,
  outboxMessages,
  projects,
  runs,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { getContainerImageDigestReference } from "../container-images/container-image.service.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type EnvironmentRow = typeof environments.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ContainerImageRow = typeof containerImages.$inferSelect;

/** Drizzle transaction type for the current PostgreSQL client. */
export type DeploymentDbTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateEnvironmentInput {
  projectId: string;
  name: string;
  slug: string;
  targetType: "ssh_ec2" | "s3";
  targetConfig: Record<string, unknown>;
  deploymentBranch: string;
  healthCheckUrl?: string | null;
  healthCheckTimeoutSeconds?: number;
}

export interface UpdateEnvironmentInput {
  environmentId: string;
  name?: string;
  slug?: string;
  targetType?: "ssh_ec2" | "s3";
  targetConfig?: Record<string, unknown>;
  deploymentBranch?: string;
  healthCheckUrl?: string | null;
  healthCheckTimeoutSeconds?: number;
}

export interface DeploymentReleaseInput {
  artifactId?: string;
  containerImageId?: string;
}

export interface CreateDeploymentInput extends DeploymentReleaseInput {
  environmentId: string;
  runId: string;
}

export interface DeploymentGateEvaluation {
  eligible: boolean;
  run: RunRow;
  reason:
    | "eligible"
    | "not_latest_successful_run"
    | "newer_run_pending"
    | "already_deployed"
    | "run_not_successful";
  newerPendingRunId?: string;
  latestSuccessfulDeploymentRunId?: string;
}

export interface DeploymentHistoryOptions {
  environmentId: string;
  limit?: number;
}

export interface RequeueQueuedDeploymentInput {
  deploymentId: string;
  triggerRunId: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTP_URL_PROTOCOLS = new Set(["http:", "https:"]);
const ECR_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const MAX_ERROR_MESSAGE_LENGTH = 4_000;
const ACTIVE_DEPLOYMENT_STATUSES: Array<DeploymentRow["status"]> = [
  "queued",
  "deploying",
  "verifying",
];

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                            */
/* -------------------------------------------------------------------------- */

const getPgCode = (error: unknown): string | undefined => {
  const seen = new Set<object>();
  let current: unknown = error;

  while (current !== null && typeof current === "object") {
    if (seen.has(current)) {
      return undefined;
    }

    seen.add(current);

    const candidate = current as {
      code?: unknown;
      cause?: unknown;
    };

    if (typeof candidate.code === "string") {
      return candidate.code;
    }

    current = candidate.cause;
  }

  return undefined;
};

const isUniqueViolation = (error: unknown): boolean =>
  getPgCode(error) === "23505";

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value;
};

const normalizeRequiredString = (
  value: string,
  field: string,
  maxLength: number,
): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AppError(`${field} cannot be empty`, 400);
  }

  if (normalized.length > maxLength) {
    throw new AppError(`${field} cannot exceed ${maxLength} characters`, 400);
  }

  return normalized;
};

const normalizeSlug = (slug: string): string => {
  const normalized = normalizeRequiredString(
    slug,
    "Environment slug",
    128,
  ).toLowerCase();

  if (!SLUG_PATTERN.test(normalized)) {
    throw new AppError(
      "Environment slug may contain only lowercase letters, numbers and single hyphens",
      400,
    );
  }

  return normalized;
};

const validateTargetConfig = (targetConfig: unknown): void => {
  if (
    targetConfig === null ||
    typeof targetConfig !== "object" ||
    Array.isArray(targetConfig)
  ) {
    throw new AppError("Environment targetConfig must be a JSON object", 400);
  }
};

const normalizeHealthCheckUrl = (
  healthCheckUrl: string | null,
): string | null => {
  if (healthCheckUrl === null) {
    return null;
  }

  const normalized = healthCheckUrl.trim();

  if (normalized.length === 0) {
    throw new AppError(
      "Health check URL cannot be empty",
      400,
    );
  }

  let url: URL;

  try {
    url = new URL(normalized);
  } catch {
    throw new AppError(
      "Health check URL is invalid",
      400,
    );
  }

  if (
    !HTTP_URL_PROTOCOLS.has(url.protocol)
  ) {
    throw new AppError(
      "Health check URL must use HTTP or HTTPS",
      400,
    );
  }

  return normalized;
};
const validateEnvironmentTarget = ({
  targetType,
  healthCheckUrl,
}: {
  targetType: CreateEnvironmentInput["targetType"];
  healthCheckUrl: string | null | undefined;
}): void => {
  if (targetType === "ssh_ec2" && !healthCheckUrl) {
    throw new AppError(
      "ssh_ec2 environments require a health check URL",
      400,
    );
  }
};

const toSafeErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "Unknown deployment error";

  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

/* -------------------------------------------------------------------------- */
/* Environment CRUD                                                           */
/* -------------------------------------------------------------------------- */

export const createEnvironment = async (
  input: CreateEnvironmentInput,
): Promise<EnvironmentRow> => {
  requireUuid(input.projectId, "project ID");

  const name = normalizeRequiredString(input.name, "Environment name", 128);
  const slug = normalizeSlug(input.slug);
  const deploymentBranch = normalizeRequiredString(
    input.deploymentBranch,
    "Deployment branch",
    128,
  );

  validateTargetConfig(input.targetConfig);

  const healthCheckUrl =  input.healthCheckUrl === undefined
    ? undefined
    : normalizeHealthCheckUrl(
        input.healthCheckUrl,
      );;
  validateEnvironmentTarget({
    targetType: input.targetType,
    healthCheckUrl,
  });

  const healthCheckTimeoutSeconds = input.healthCheckTimeoutSeconds ?? 30;

  if (
    !Number.isInteger(healthCheckTimeoutSeconds) ||
    healthCheckTimeoutSeconds <= 0
  ) {
    throw new AppError(
      "Health check timeout must be a positive integer",
      400,
    );
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  try {
    const [environment] = await db
      .insert(environments)
      .values({
        projectId: input.projectId,
        name,
        slug,
        targetType: input.targetType,
        targetConfig: input.targetConfig,
        deploymentBranch,
        healthCheckUrl,
        healthCheckTimeoutSeconds,
      })
      .returning();

    if (!environment) {
      throw new AppError("Environment could not be created", 500);
    }

    return environment;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isUniqueViolation(error)) {
      throw new AppError("An environment with this slug already exists", 409);
    }

    throw error;
  }
};

export const getEnvironment = async (
  environmentId: string,
): Promise<EnvironmentRow> => {
  requireUuid(environmentId, "environment ID");

  const [environment] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);

  if (!environment) {
    throw new AppError("Environment not found", 404);
  }

  return environment;
};

export const updateEnvironment = async (
  input: UpdateEnvironmentInput,
): Promise<EnvironmentRow> => {
  requireUuid(input.environmentId, "environment ID");

  if (
    input.name === undefined &&
    input.slug === undefined &&
    input.targetType === undefined &&
    input.targetConfig === undefined &&
    input.deploymentBranch === undefined &&
    input.healthCheckUrl === undefined &&
    input.healthCheckTimeoutSeconds === undefined
  ) {
    throw new AppError("At least one environment field must be provided", 400);
  }

  const [existing] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, input.environmentId))
    .limit(1);

  if (!existing) {
    throw new AppError("Environment not found", 404);
  }

  const changes: Partial<EnvironmentRow> = {};

  if (input.name !== undefined) {
    changes.name = normalizeRequiredString(
      input.name,
      "Environment name",
      128,
    );
  }

  if (input.slug !== undefined) {
    changes.slug = normalizeSlug(input.slug);
  }

  if (input.targetType !== undefined) {
    changes.targetType = input.targetType;
  }

  if (input.targetConfig !== undefined) {
    validateTargetConfig(input.targetConfig);
    changes.targetConfig = input.targetConfig;
  }

  if (input.deploymentBranch !== undefined) {
    changes.deploymentBranch = normalizeRequiredString(
      input.deploymentBranch,
      "Deployment branch",
      128,
    );
  }

  if (input.healthCheckUrl !== undefined) {
    changes.healthCheckUrl = normalizeHealthCheckUrl(input.healthCheckUrl);
  }

  if (input.healthCheckTimeoutSeconds !== undefined) {
    if (
      !Number.isInteger(input.healthCheckTimeoutSeconds) ||
      input.healthCheckTimeoutSeconds <= 0
    ) {
      throw new AppError(
        "Health check timeout must be a positive integer",
        400,
      );
    }

    changes.healthCheckTimeoutSeconds = input.healthCheckTimeoutSeconds;
  }

  const nextTargetType = changes.targetType ?? existing.targetType;
  const nextHealthCheckUrl =
    changes.healthCheckUrl !== undefined
      ? changes.healthCheckUrl
      : existing.healthCheckUrl;

  validateEnvironmentTarget({
    targetType: nextTargetType,
    healthCheckUrl: nextHealthCheckUrl,
  });

  try {
    const [updated] = await db
      .update(environments)
      .set({
        ...changes,
        updatedAt: new Date(),
      })
      .where(eq(environments.id, input.environmentId))
      .returning();

    if (!updated) {
      throw new AppError("Environment not found", 404);
    }

    return updated;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isUniqueViolation(error)) {
      throw new AppError("An environment with this slug already exists", 409);
    }

    throw error;
  }
};

/* -------------------------------------------------------------------------- */
/* Stage 36 — Deployment Gate                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Schema-authoritative deployment rule.
 *
 * 1. The candidate must be successful and the newest successful run on the
 *    environment's deployment branch.
 * 2. There must be no newer queued/running run on that branch.
 * 3. The candidate must be newer than the run behind the newest successful
 *    deployment with action = deploy.
 *
 * `branch_heads` is intentionally not read here. It is not deployment
 * authority in the current schema.
 *
 * Caller contract: the transaction must already hold `FOR UPDATE` on the
 * environment row.
 */
export const evaluateDeploymentGateInTransaction = async ({
  tx,
  environment,
  runId,
}: {
  tx: DeploymentDbTransaction;
  environment: EnvironmentRow;
  runId: string;
}): Promise<DeploymentGateEvaluation> => {
  requireUuid(runId, "run ID");

  const [run] = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.projectId, environment.projectId),
        eq(runs.branch, environment.deploymentBranch),
      ),
    )
    .limit(1);

  if (!run) {
    throw new AppError("Run not found for this environment", 404);
  }

  if (run.status !== "success") {
    return {
      eligible: false,
      run,
      reason: "run_not_successful",
    };
  }

  const [newestSuccessfulRun] = await tx
    .select({
      id: runs.id,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, environment.projectId),
        eq(runs.branch, environment.deploymentBranch),
        eq(runs.status, "success"),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);

  if (!newestSuccessfulRun || newestSuccessfulRun.id !== run.id) {
    return {
      eligible: false,
      run,
      reason: "not_latest_successful_run",
    };
  }

  const [newerPendingRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, environment.projectId),
        eq(runs.branch, environment.deploymentBranch),
        inArray(runs.status, ["queued", "running"]),
        gt(runs.createdAt, run.createdAt),
      ),
    )
    .orderBy(runs.createdAt, runs.id)
    .limit(1);

  if (newerPendingRun) {
    return {
      eligible: false,
      run,
      reason: "newer_run_pending",
      newerPendingRunId: newerPendingRun.id,
    };
  }

  const [latestSuccessfulDeployment] = await tx
    .select({
      deployedRun: runs,
    })
    .from(deployments)
    .innerJoin(runs, eq(deployments.runId, runs.id))
    .where(
      and(
        eq(deployments.environmentId, environment.id),
        eq(deployments.action, "deploy"),
        eq(deployments.status, "success"),
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);

  if (
    latestSuccessfulDeployment &&
    run.createdAt <= latestSuccessfulDeployment.deployedRun.createdAt
  ) {
    return {
      eligible: false,
      run,
      reason: "already_deployed",
      latestSuccessfulDeploymentRunId:
        latestSuccessfulDeployment.deployedRun.id,
    };
  }

  return {
    eligible: true,
    run,
    reason: "eligible",
     ...(latestSuccessfulDeployment === undefined
    ? {}
    : {
        latestSuccessfulDeploymentRunId:
          latestSuccessfulDeployment.deployedRun.id,
      }),
  };
};

export const checkDeploymentEligibility = async ({
  environmentId,
  runId,
}: {
  environmentId: string;
  runId: string;
}): Promise<DeploymentGateEvaluation> => {
  requireUuid(environmentId, "environment ID");
  requireUuid(runId, "run ID");

  return db.transaction(async (tx) => {
    const [environment] = await tx
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .for("update")
      .limit(1);

    if (!environment) {
      throw new AppError("Environment not found", 404);
    }

    return evaluateDeploymentGateInTransaction({
      tx,
      environment,
      runId,
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Release validation                                                         */
/* -------------------------------------------------------------------------- */

export interface ResolvedDeploymentRelease {
  artifactId: string | null;
  containerImageId: string | null;
  releaseRef: string;
}

export const loadUsableArtifactInTransaction = async ({
  tx,
  artifactId,
  runId,
}: {
  tx: DeploymentDbTransaction;
  artifactId: string;
  runId?: string;
}): Promise<ArtifactRow> => {
  requireUuid(artifactId, "artifact ID");

  if (runId !== undefined) {
    requireUuid(runId, "run ID");
  }

  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(
      runId === undefined
        ? eq(artifacts.id, artifactId)
        : and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)),
    )
    .limit(1);

  if (!artifact) {
    throw new AppError(
      runId === undefined
        ? "Artifact not found"
        : "Artifact not found for this run",
      404,
    );
  }

  const now = new Date();

  if (
    artifact.kind !== "archive" ||
    artifact.status !== "ready" ||
    !artifact.uploadedAt ||
    artifact.deletedAt !== null ||
    (artifact.expiresAt !== null && artifact.expiresAt <= now)
  ) {
    throw new AppError("Artifact is no longer usable", 409);
  }

  return artifact;
};

export const loadUsableContainerImageInTransaction = async ({
  tx,
  containerImageId,
  runId,
}: {
  tx: DeploymentDbTransaction;
  containerImageId: string;
  runId?: string;
}): Promise<ContainerImageRow> => {
  requireUuid(containerImageId, "container image ID");

  if (runId !== undefined) {
    requireUuid(runId, "run ID");
  }

  const [image] = await tx
    .select()
    .from(containerImages)
    .where(
      runId === undefined
        ? eq(containerImages.id, containerImageId)
        : and(
            eq(containerImages.id, containerImageId),
            eq(containerImages.runId, runId),
          ),
    )
    .limit(1);

  if (!image) {
    throw new AppError(
      runId === undefined
        ? "Container image not found"
        : "Container image not found for this run",
      404,
    );
  }

  if (!ECR_DIGEST_PATTERN.test(image.digest)) {
    throw new AppError("Container image has an invalid digest", 409);
  }

  return image;
};

const buildArtifactReleaseRef = (artifact: ArtifactRow): string => {
  const releaseRef = `s3://${artifact.s3BucketName}/${artifact.objectKey}`;

  if (releaseRef.length > 512) {
    throw new AppError("Artifact release reference is too long", 500);
  }

  return releaseRef;
};

const buildContainerImageReleaseRef = (
  image: ContainerImageRow,
): string => {
  const releaseRef = getContainerImageDigestReference({
    registry: image.registry,
    repository: image.repository,
    digest: image.digest,
  });

  if (releaseRef.length > 512) {
    throw new AppError("Container image release reference is too long", 500);
  }

  return releaseRef;
};

export const resolveDeploymentReleaseInTransaction = async ({
  tx,
  environment,
  runId,
  artifactId,
  containerImageId,
}: {
  tx: DeploymentDbTransaction;
  environment: EnvironmentRow;
  runId: string;
  artifactId?: string;
  containerImageId?: string;
}): Promise<ResolvedDeploymentRelease> => {
  requireUuid(runId, "run ID");

  const hasArtifact = artifactId !== undefined;
  const hasImage = containerImageId !== undefined;

  if (hasArtifact === hasImage) {
    throw new AppError(
      "Provide exactly one release: artifactId or containerImageId",
      400,
    );
  }

  if (environment.targetType === "s3") {
    if (!hasArtifact) {
      throw new AppError("s3 environments require artifactId", 400);
    }

    const artifact = await loadUsableArtifactInTransaction({
      tx,
      artifactId: artifactId!,
      runId,
    });

    return {
      artifactId: artifact.id,
      containerImageId: null,
      releaseRef: buildArtifactReleaseRef(artifact),
    };
  }

  if (!hasImage) {
    throw new AppError("ssh_ec2 environments require containerImageId", 400);
  }

  const image = await loadUsableContainerImageInTransaction({
    tx,
    containerImageId: containerImageId!,
    runId,
  });

  return {
    artifactId: null,
    containerImageId: image.id,
    releaseRef: buildContainerImageReleaseRef(image),
  };
};

/* -------------------------------------------------------------------------- */
/* Stage 34 — Deployment Creation                                             */
/* -------------------------------------------------------------------------- */

const getIneligibleDeploymentError = (
  gate: DeploymentGateEvaluation,
): AppError => {
  switch (gate.reason) {
    case "run_not_successful":
      return new AppError(
        "Run is not successful and cannot be deployed",
        409,
      );
    case "not_latest_successful_run":
      return new AppError(
        "This is not the newest successful run on the deployment branch",
        409,
      );
    case "newer_run_pending":
      return new AppError(
        "A newer run is queued or running; deployment must wait",
        409,
      );
    case "already_deployed":
      return new AppError(
        "Run is not newer than the latest successful deployment",
        409,
      );
    case "eligible":
      return new AppError(
        "Deployment run is already eligible",
        500,
      );
  }
};

const supersedeQueuedDeploymentInTransaction = async ({
  tx,
  deploymentId,
  message,
}: {
  tx: DeploymentDbTransaction;
  deploymentId: string;
  message: string;
}): Promise<void> => {
  const now = new Date();

  await tx
    .update(deployments)
    .set({
      status: "superseded",
      errorCode: "DEPLOYMENT_SUPERSEDED",
      errorMessage: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.status, "queued"),
      ),
    );
};

export const createDeployment = async (
  input: CreateDeploymentInput,
): Promise<DeploymentRow> => {
  requireUuid(input.environmentId, "environment ID");
  requireUuid(input.runId, "run ID");

  if (input.artifactId !== undefined) {
    requireUuid(input.artifactId, "artifact ID");
  }

  if (input.containerImageId !== undefined) {
    requireUuid(input.containerImageId, "container image ID");
  }

  try {
    return await db.transaction(async (tx) => {
      const [environment] = await tx
        .select()
        .from(environments)
        .where(eq(environments.id, input.environmentId))
        .for("update")
        .limit(1);

      if (!environment) {
        throw new AppError("Environment not found", 404);
      }

      const gate = await evaluateDeploymentGateInTransaction({
        tx,
        environment,
        runId: input.runId,
      });

      if (!gate.eligible) {
        throw getIneligibleDeploymentError(gate);
      }

      const [activeDeployment] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.environmentId, environment.id),
            inArray(deployments.status, ACTIVE_DEPLOYMENT_STATUSES),
          ),
        )
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .for("update")
        .limit(1);

      if (activeDeployment) {
        if (
          activeDeployment.status === "queued" &&
          activeDeployment.action === "deploy" &&
          activeDeployment.runId === input.runId
        ) {
          const sameRelease =
            activeDeployment.artifactId === (input.artifactId ?? null) &&
            activeDeployment.containerImageId ===
              (input.containerImageId ?? null);

          if (!sameRelease) {
            throw new AppError(
              "A deployment for this run is already queued with a different release",
              409,
            );
          }

          return activeDeployment;
        }

        if (
          activeDeployment.status === "queued" &&
          activeDeployment.action === "deploy" &&
          activeDeployment.runId !== null
        ) {
          const [activeRun] = await tx
            .select({ createdAt: runs.createdAt })
            .from(runs)
            .where(eq(runs.id, activeDeployment.runId))
            .limit(1);

          if (
            activeRun !== undefined &&
            gate.run.createdAt > activeRun.createdAt
          ) {
            await supersedeQueuedDeploymentInTransaction({
              tx,
              deploymentId: activeDeployment.id,
              message:
                "A newer eligible deployment replaced this queued deployment",
            });
          } else {
            throw new AppError(
              "Another deployment is already queued for this environment",
              409,
            );
          }
        } else {
          throw new AppError(
            "Another deployment is already in progress for this environment",
            409,
          );
        }
      }

const release = await resolveDeploymentReleaseInTransaction({
  tx,
  environment,
  runId: input.runId,
  ...(input.artifactId === undefined
    ? {}
    : { artifactId: input.artifactId }),
  ...(input.containerImageId === undefined
    ? {}
    : { containerImageId: input.containerImageId }),
});

      const [deployment] = await tx
        .insert(deployments)
        .values({
          runId: gate.run.id,
          environmentId: environment.id,
          rollbackToDeploymentId: null,
          containerImageId: release.containerImageId,
          artifactId: release.artifactId,
          action: "deploy",
          status: "queued",
          commitSha: gate.run.commitSha,
          // Captured atomically when the worker claims queued -> deploying.
          previousCommitSha: null,
          releaseRef: release.releaseRef,
          previousReleaseRef: null,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
        })
        .returning();

      if (!deployment) {
        throw new AppError("Deployment could not be created", 500);
      }

      await tx
        .update(environments)
        .set({
          desiredRunId: gate.run.id,
          desiredCommitSha: gate.run.commitSha,
          updatedAt: new Date(),
        })
        .where(eq(environments.id, environment.id));

      await tx.insert(outboxMessages).values({
        messageType: "deployment.requested",
        aggregateType: "deployment",
        aggregateId: deployment.id,
        dedupeKey: `deployment.requested:${deployment.id}`,
        payload: {
          deploymentId: deployment.id,
        },
        queueName: "deployment",
        status: "pending",
      });

      return deployment;
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isUniqueViolation(error)) {
      throw new AppError(
        "A deployment is already active for this environment",
        409,
      );
    }

    throw error;
  }
};

/* -------------------------------------------------------------------------- */
/* Worker state helpers                                                       */
/* -------------------------------------------------------------------------- */

export interface MarkDeploymentFailedInput {
  deploymentId: string;
  errorCode: string;
  errorMessage: string;
}

export const markDeploymentFailed = async ({
  deploymentId,
  errorCode,
  errorMessage,
}: MarkDeploymentFailedInput): Promise<void> => {
  requireUuid(deploymentId, "deployment ID");

  await db
    .update(deployments)
    .set({
      status: "failed",
      errorCode: errorCode.slice(0, 128),
      errorMessage: errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        inArray(deployments.status, [
          "queued",
          "deploying",
          "verifying",
        ]),
      ),
    );
};

export const toDeploymentError = (error: unknown): {
  errorCode: string;
  errorMessage: string;
} => ({
  errorCode:
    error instanceof AppError
      ? "DEPLOYMENT_ERROR"
      : "DEPLOYMENT_EXECUTION_FAILED",
  errorMessage: toSafeErrorMessage(error),
});

/* -------------------------------------------------------------------------- */
/* Reconciliation of an existing queued deployment                            */
/* -------------------------------------------------------------------------- */

/**
 * Called after a run or deployment finishes.
 *
 * This does not create a new deployment. It re-evaluates an existing queued
 * deployment and creates a fresh outbox message when that deployment becomes
 * eligible again. This is important when a newer queued/running run caused an
 * older successful run to wait and the newer run later fails/cancels.
 */
export const requeueQueuedDeployment = async ({
  deploymentId,
  triggerRunId,
}: RequeueQueuedDeploymentInput): Promise<boolean> => {
  requireUuid(deploymentId, "deployment ID");
  requireUuid(triggerRunId, "trigger run ID");

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        deployment: deployments,
        environment: environments,
      })
      .from(deployments)
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .where(eq(deployments.id, deploymentId))
      .for("update")
      .limit(1);

    if (!row) {
      throw new AppError("Deployment not found", 404);
    }

    if (row.deployment.status !== "queued") {
      return false;
    }

    if (row.deployment.action !== "deploy" || row.deployment.runId === null) {
      return false;
    }

    const gate = await evaluateDeploymentGateInTransaction({
      tx,
      environment: row.environment,
      runId: row.deployment.runId,
    });

    if (!gate.eligible) {
      if (
        gate.reason === "not_latest_successful_run" ||
        gate.reason === "already_deployed" ||
        gate.reason === "run_not_successful"
      ) {
        await supersedeQueuedDeploymentInTransaction({
          tx,
          deploymentId: row.deployment.id,
          message: "Queued deployment is no longer deployment-eligible",
        });
      }

      return false;
    }

    await tx
      .insert(outboxMessages)
      .values({
        messageType: "deployment.requested",
        aggregateType: "deployment",
        aggregateId: row.deployment.id,
        dedupeKey: `deployment.recheck:${row.deployment.id}:${triggerRunId}`,
        payload: {
          deploymentId: row.deployment.id,
          reason: "deployment_recheck",
        },
        queueName: "deployment",
        status: "pending",
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          return;
        }

        throw error;
      });

    return true;
  });
};

/* -------------------------------------------------------------------------- */
/* Stage 40 — Deployment History                                              */
/* -------------------------------------------------------------------------- */

export const getDeployment = async (
  deploymentId: string,
): Promise<DeploymentRow> => {
  requireUuid(deploymentId, "deployment ID");

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  if (!deployment) {
    throw new AppError("Deployment not found", 404);
  }

  return deployment;
};

export const listDeploymentHistory = async ({
  environmentId,
  limit = 50,
}: DeploymentHistoryOptions): Promise<DeploymentRow[]> => {
  requireUuid(environmentId, "environment ID");

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError(
      "Deployment history limit must be between 1 and 100",
      400,
    );
  }

  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);

  if (!environment) {
    throw new AppError("Environment not found", 404);
  }

  return db
    .select()
    .from(deployments)
    .where(eq(deployments.environmentId, environmentId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(limit);
};
