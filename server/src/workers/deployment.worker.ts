import type { Job } from "bullmq";
import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import { db } from "../db/index.js";
import {
  deployments,
  environments,
  runs,
} from "../db/schema.js";
import { AppError } from "../utils/app.error.js";
import {
  checkDeploymentHealth,
  type HealthCheckResult,
} from "../services/deployments/health-check.service.js";
import {
  evaluateDeploymentGateInTransaction,
  loadUsableArtifactInTransaction,
  loadUsableContainerImageInTransaction,
  markDeploymentFailed,
  toDeploymentError,
  type ArtifactRow,
  type ContainerImageRow,
  type DeploymentDbTransaction,
  type DeploymentRow,
  type EnvironmentRow,
} from "../services/deployments/deployment.service.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface DeploymentJobPayload {
  deploymentId: string;
}

export interface DeploymentExecutionInput {
  deployment: DeploymentRow;
  environment: EnvironmentRow;
  artifact: ArtifactRow | null;
  containerImage: ContainerImageRow | null;
  signal: AbortSignal;
}

export interface DeploymentTargetExecutor {
  deploy(input: DeploymentExecutionInput): Promise<void>;
}

export interface DeploymentFinishedContext {
  deployment: DeploymentRow;
  environment: EnvironmentRow;
}

export interface DeploymentWorkerDependencies {
  executor: DeploymentTargetExecutor;
  onDeploymentFinished?: (
    context: DeploymentFinishedContext,
  ) => Promise<void>;
}

interface DeploymentContext {
  deployment: DeploymentRow;
  environment: EnvironmentRow;
  run: typeof runs.$inferSelect | null;
  artifact: ArtifactRow | null;
  containerImage: ContainerImageRow | null;
}

type ClaimResult =
  | {
      status: "claimed";
      context: DeploymentContext;
    }
  | {
      status: "waiting";
    }
  | {
      status: "superseded";
    }
  | {
      status: "already_finished";
    };

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES: Array<DeploymentRow["status"]> = [
  "queued",
  "deploying",
  "verifying",
];
const ECR_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value;
};

const toBoundedMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "Deployment failed";
  return message.slice(0, 4_000);
};

const markQueuedDeploymentSuperseded = async ({
  tx,
  deploymentId,
  message,
}: {
  tx: DeploymentDbTransaction;
  deploymentId: string;
  message: string;
}): Promise<void> => {
  await tx
    .update(deployments)
    .set({
      status: "superseded",
      errorCode: "DEPLOYMENT_NO_LONGER_ELIGIBLE",
      errorMessage: message.slice(0, 4_000),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.status, "queued"),
      ),
    );
};

const validateClaimedRelease = ({
  deployment,
  environment,
  artifact,
  containerImage,
}: {
  deployment: DeploymentRow;
  environment: EnvironmentRow;
  artifact: ArtifactRow | null;
  containerImage: ContainerImageRow | null;
}): void => {
  if (environment.targetType === "s3") {
    if (
      deployment.artifactId === null ||
      deployment.containerImageId !== null ||
      artifact === null
    ) {
      throw new AppError(
        "Deployment release does not match the S3 environment",
        409,
      );
    }

    if (
      artifact.kind !== "archive" ||
      artifact.status !== "ready" ||
      artifact.uploadedAt === null ||
      artifact.deletedAt !== null ||
      (artifact.expiresAt !== null && artifact.expiresAt <= new Date())
    ) {
      throw new AppError("Deployment artifact is no longer usable", 409);
    }

    const releaseRef = `s3://${artifact.s3BucketName}/${artifact.objectKey}`;

    if (releaseRef !== deployment.releaseRef) {
      throw new AppError(
        "Deployment artifact does not match its release reference",
        409,
      );
    }

    return;
  }

  if (
    deployment.containerImageId === null ||
    deployment.artifactId !== null ||
    containerImage === null
  ) {
    throw new AppError(
      "Deployment release does not match the EC2 environment",
      409,
    );
  }

  if (!ECR_DIGEST_PATTERN.test(containerImage.digest)) {
    throw new AppError(
      "Deployment container image has an invalid digest",
      409,
    );
  }

  const releaseRef = `${containerImage.registry}/${containerImage.repository}@${containerImage.digest}`;

  if (releaseRef !== deployment.releaseRef) {
    throw new AppError(
      "Deployment image does not match its release reference",
      409,
    );
  }
};

const notifyDeploymentFinished = async (
  dependencies: DeploymentWorkerDependencies,
  deploymentId: string,
): Promise<void> => {
  if (dependencies.onDeploymentFinished === undefined) {
    return;
  }

  try {
    const [row] = await db
      .select({
        deployment: deployments,
        environment: environments,
      })
      .from(deployments)
      .innerJoin(
        environments,
        eq(deployments.environmentId, environments.id),
      )
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!row) {
      return;
    }

    if (
      row.deployment.status !== "success" &&
      row.deployment.status !== "failed" &&
      row.deployment.status !== "superseded" &&
      row.deployment.status !== "canceled"
    ) {
      return;
    }

    await dependencies.onDeploymentFinished({
      deployment: row.deployment,
      environment: row.environment,
    });
  } catch {
    // Reconciliation is best-effort. The deployment's durable status is
    // already stored and must not be changed because a follow-up failed.
  }
};

/* -------------------------------------------------------------------------- */
/* Claim                                                                      */
/* -------------------------------------------------------------------------- */

const claimDeployment = async (
  deploymentId: string,
): Promise<ClaimResult> => {
  return db.transaction(async (tx) => {
    /*
     * The schema-authoritative deployment rule requires the environment row
     * to be locked for the whole gate/claim transaction. Lock it first, then
     * load the deployment belonging to that environment.
     */
    const [deploymentRow] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);

    if (!deploymentRow) {
      throw new AppError("Deployment not found", 404);
    }

    const [environment] = await tx
      .select()
      .from(environments)
      .where(eq(environments.id, deploymentRow.environmentId))
      .for("update")
      .limit(1);

    if (!environment) {
      throw new AppError("Deployment environment not found", 409);
    }

    const [deployment] = await tx
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for("update")
      .limit(1);

    if (!deployment) {
      throw new AppError("Deployment no longer exists", 409);
    }

    const row = { deployment, environment };

    if (row.deployment.status !== "queued") {
      if (
        row.deployment.status === "success" ||
        row.deployment.status === "failed" ||
        row.deployment.status === "superseded" ||
        row.deployment.status === "canceled"
      ) {
        return { status: "already_finished" };
      }

      throw new AppError("Deployment is already being processed", 409);
    }

    /*
     * A deployment is serialized per environment by the schema's partial
     * unique index. Never burn a queued deployment just because another
     * deployment is currently active; leave it queued for re-evaluation.
     */
    const [activeDeployment] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.environmentId, row.environment.id),
          inArray(deployments.status, ACTIVE_STATUSES),
          sql`${deployments.id} <> ${deploymentId}`,
        ),
      )
      .limit(1);

    if (activeDeployment) {
      return { status: "waiting" };
    }

    let run: typeof runs.$inferSelect | null = null;

    if (row.deployment.action === "deploy") {
      if (row.deployment.runId === null) {
        throw new AppError("Normal deployment is missing its run", 500);
      }

      const gate = await evaluateDeploymentGateInTransaction({
        tx,
        environment: row.environment,
        runId: row.deployment.runId,
      });

      if (!gate.eligible) {
        if (gate.reason === "newer_run_pending") {
          // Wait. The run-finish path must re-evaluate/requeue this row.
          return { status: "waiting" };
        }

        await markQueuedDeploymentSuperseded({
          tx,
          deploymentId: row.deployment.id,
          message: gate.reason === "not_latest_successful_run"
            ? "A newer successful run is now deployment-authoritative"
            : gate.reason === "already_deployed"
              ? "A newer or equal successful deployment already exists"
              : "The deployment run is no longer successful",
        });

        return { status: "superseded" };
      }

      run = gate.run;
    } else {
      if (row.deployment.rollbackToDeploymentId === null) {
        throw new AppError(
          "Rollback deployment is missing its rollback target",
          500,
        );
      }

      const [target] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, row.deployment.rollbackToDeploymentId))
        .for("update")
        .limit(1);

      if (!target) {
        throw new AppError("Rollback target deployment no longer exists", 409);
      }

      if (
        target.environmentId !== row.environment.id ||
        target.status !== "success" ||
        target.commitSha !== row.deployment.commitSha ||
        target.releaseRef !== row.deployment.releaseRef
      ) {
        throw new AppError("Rollback target is no longer valid", 409);
      }

      if (target.runId !== null) {
        const [targetRun] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, target.runId))
          .limit(1);

        run = targetRun ?? null;
      }
    }

    const artifact =
      row.deployment.artifactId === null
        ? null
        : await loadUsableArtifactInTransaction({
            tx,
            artifactId: row.deployment.artifactId,
          });

    const containerImage =
      row.deployment.containerImageId === null
        ? null
        : await loadUsableContainerImageInTransaction({
            tx,
            containerImageId: row.deployment.containerImageId,
          });

    validateClaimedRelease({
      deployment: row.deployment,
      environment: row.environment,
      artifact,
      containerImage,
    });

    const now = new Date();

    const [claimed] = await tx
      .update(deployments)
      .set({
        status: "deploying",
        startedAt: now,
        previousCommitSha: row.environment.currentCommitSha,
        previousReleaseRef: row.environment.currentReleaseRef,
        updatedAt: now,
      })
      .where(
        and(
          eq(deployments.id, deploymentId),
          eq(deployments.status, "queued"),
        ),
      )
      .returning();

    if (!claimed) {
      throw new AppError("Deployment could not be claimed", 409);
    }

    return {
      status: "claimed",
      context: {
        deployment: claimed,
        environment: row.environment,
        run,
        artifact,
        containerImage,
      },
    };
  });
};

/* -------------------------------------------------------------------------- */
/* Main worker                                                               */
/* -------------------------------------------------------------------------- */

export const processDeploymentJob = async (
  job: Job<DeploymentJobPayload>,
  dependencies: DeploymentWorkerDependencies,
): Promise<void> => {
  const deploymentId = requireUuid(job.data?.deploymentId, "deployment ID");
  const claim = await claimDeployment(deploymentId);

  if (claim.status === "already_finished") {
    return;
  }

  if (claim.status === "waiting") {
    return;
  }

  if (claim.status === "superseded") {
    await notifyDeploymentFinished(dependencies, deploymentId);
    return;
  }

  const { deployment, environment, artifact, containerImage } = claim.context;
  const controller = new AbortController();

  try {
    await dependencies.executor.deploy({
      deployment,
      environment,
      artifact,
      containerImage,
      signal: controller.signal,
    });

    const [verifying] = await db
      .update(deployments)
      .set({
        status: "verifying",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deployments.id, deployment.id),
          eq(deployments.status, "deploying"),
        ),
      )
      .returning();

    if (!verifying) {
      throw new AppError(
        "Deployment could not enter verification state",
        409,
      );
    }

    const health: HealthCheckResult = await checkDeploymentHealth({
      environment,
      signal: controller.signal,
    });

    if (!health.healthy) {
      await markDeploymentFailed({
        deploymentId: deployment.id,
        errorCode: "HEALTH_CHECK_FAILED",
        errorMessage: health.message,
      });
      await notifyDeploymentFinished(dependencies, deployment.id);
      return;
    }

    await db.transaction(async (tx) => {
      const [lockedEnvironment] = await tx
        .select()
        .from(environments)
        .where(eq(environments.id, environment.id))
        .for("update")
        .limit(1);

      if (!lockedEnvironment) {
        throw new AppError("Environment no longer exists", 409);
      }

      const [lockedDeployment] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, deployment.id))
        .for("update")
        .limit(1);

      if (!lockedDeployment) {
        throw new AppError("Deployment no longer exists", 409);
      }

      if (lockedDeployment.status !== "verifying") {
        throw new AppError(
          "Deployment is no longer in verifying state; current state was not changed",
          409,
        );
      }

      const [updatedEnvironment] = await tx
        .update(environments)
        .set(
          lockedEnvironment.targetType === "s3"
            ? {
                currentCommitSha: lockedDeployment.commitSha,
                currentReleaseRef: lockedDeployment.releaseRef,
                currentArtifactId: lockedDeployment.artifactId,
                currentImageId: null,
                desiredRunId: lockedDeployment.runId,
                desiredCommitSha: lockedDeployment.commitSha,
                updatedAt: new Date(),
              }
            : {
                currentCommitSha: lockedDeployment.commitSha,
                currentReleaseRef: lockedDeployment.releaseRef,
                currentArtifactId: null,
                currentImageId: lockedDeployment.containerImageId,
                desiredRunId: lockedDeployment.runId,
                desiredCommitSha: lockedDeployment.commitSha,
                updatedAt: new Date(),
              },
        )
        .where(eq(environments.id, lockedEnvironment.id))
        .returning();

      if (!updatedEnvironment) {
        throw new AppError("Environment state could not be updated", 500);
      }

      const [success] = await tx
        .update(deployments)
        .set({
          status: "success",
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.id, lockedDeployment.id),
            eq(deployments.status, "verifying"),
          ),
        )
        .returning();

      if (!success) {
        throw new AppError("Deployment could not be marked successful", 500);
      }

    });

    await notifyDeploymentFinished(dependencies, deployment.id);
  } catch (error: unknown) {
    const { errorCode, errorMessage } = toDeploymentError(error);

    await markDeploymentFailed({
      deploymentId: deployment.id,
      errorCode,
      errorMessage: toBoundedMessage(errorMessage),
    });

    await notifyDeploymentFinished(dependencies, deployment.id);

    throw error;
  }
};
