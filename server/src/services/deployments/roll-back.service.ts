import {
  and,
  desc,
  eq,
  inArray,
} from "drizzle-orm";

import { db } from "../../db/index.js";
import {
  deployments,
  environments,
  outboxMessages,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import {
  loadUsableArtifactInTransaction,
  loadUsableContainerImageInTransaction,
  type DeploymentRow,
  type DeploymentDbTransaction,
} from "./deployment.service.js";
import type { ArtifactRow, ContainerImageRow } from "./deployment.service.js";
import { getContainerImageDigestReference } from "../container-images/container-image.service.js";

export interface CreateRollbackInput {
  environmentId: string;
  targetDeploymentId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_DEPLOYMENT_STATUSES: Array<DeploymentRow["status"]> = [
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

const buildArtifactReleaseRef = (artifact: ArtifactRow): string => {
  const releaseRef = `s3://${artifact.s3BucketName}/${artifact.objectKey}`;

  if (releaseRef.length > 512) {
    throw new AppError("Rollback release reference is too long", 500);
  }

  return releaseRef;
};

const buildContainerImageReleaseRef = (
  image: ContainerImageRow,
): string => {
  if (!ECR_DIGEST_PATTERN.test(image.digest)) {
    throw new AppError(
      "Rollback container image has an invalid digest",
      409,
    );
  }

  const releaseRef = getContainerImageDigestReference({
    registry: image.registry,
    repository: image.repository,
    digest: image.digest,
  });

  if (releaseRef.length > 512) {
    throw new AppError("Rollback release reference is too long", 500);
  }

  return releaseRef;
};

const resolveRollbackRelease = async ({
  tx,
  environment,
  targetDeployment,
}: {
  tx: DeploymentDbTransaction;
  environment: typeof environments.$inferSelect;
  targetDeployment: DeploymentRow;
}): Promise<{
  artifactId: string | null;
  containerImageId: string | null;
  releaseRef: string;
}> => {
  if (environment.targetType === "s3") {
    if (
      targetDeployment.artifactId === null ||
      targetDeployment.containerImageId !== null
    ) {
      throw new AppError(
        "Rollback target does not match the S3 environment",
        409,
      );
    }

    const artifact = await loadUsableArtifactInTransaction({
      tx,
      artifactId: targetDeployment.artifactId,
    });

    return {
      artifactId: artifact.id,
      containerImageId: null,
      releaseRef: buildArtifactReleaseRef(artifact),
    };
  }

  if (
    targetDeployment.containerImageId === null ||
    targetDeployment.artifactId !== null
  ) {
    throw new AppError(
      "Rollback target does not match the EC2 environment",
      409,
    );
  }

  const image = await loadUsableContainerImageInTransaction({
    tx,
    containerImageId: targetDeployment.containerImageId,
  });

  return {
    artifactId: null,
    containerImageId: image.id,
    releaseRef: buildContainerImageReleaseRef(image),
  };
};

export const createRollback = async (
  input: CreateRollbackInput,
): Promise<DeploymentRow> => {
  requireUuid(input.environmentId, "environment ID");
  requireUuid(input.targetDeploymentId, "rollback target deployment ID");

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

      const [targetDeployment] = await tx
        .select()
        .from(deployments)
        .where(eq(deployments.id, input.targetDeploymentId))
        .for("update")
        .limit(1);

      if (!targetDeployment) {
        throw new AppError("Rollback target deployment not found", 404);
      }

      if (targetDeployment.environmentId !== environment.id) {
        throw new AppError(
          "Rollback target belongs to another environment",
          409,
        );
      }

      if (targetDeployment.status !== "success") {
        throw new AppError(
          "Only a successful deployment can be used as a rollback target",
          409,
        );
      }

      if (
        environment.currentCommitSha === targetDeployment.commitSha &&
        environment.currentReleaseRef === targetDeployment.releaseRef
      ) {
        throw new AppError(
          "Environment is already running the selected release",
          409,
        );
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
        throw new AppError(
          "Another deployment is already active for this environment",
          409,
        );
      }

      const [existingRollback] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.environmentId, environment.id),
            eq(deployments.action, "rollback"),
            eq(deployments.rollbackToDeploymentId, targetDeployment.id),
            inArray(deployments.status, ACTIVE_DEPLOYMENT_STATUSES),
          ),
        )
        .orderBy(desc(deployments.createdAt), desc(deployments.id))
        .limit(1);

      if (existingRollback) {
        return existingRollback;
      }

      const release = await resolveRollbackRelease({
        tx,
        environment,
        targetDeployment,
      });

      if (release.releaseRef !== targetDeployment.releaseRef) {
        throw new AppError(
          "Rollback target release no longer matches its recorded release reference",
          409,
        );
      }

      const [rollback] = await tx
        .insert(deployments)
        .values({
          runId: null,
          environmentId: environment.id,
          rollbackToDeploymentId: targetDeployment.id,
          containerImageId: release.containerImageId,
          artifactId: release.artifactId,
          action: "rollback",
          status: "queued",
          commitSha: targetDeployment.commitSha,
          // Captured atomically when the worker claims queued -> deploying.
          previousCommitSha: null,
          releaseRef: targetDeployment.releaseRef,
          previousReleaseRef: null,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
        })
        .returning();

      if (!rollback) {
        throw new AppError("Rollback could not be created", 500);
      }

      await tx
        .update(environments)
        .set({
          desiredRunId: targetDeployment.runId,
          desiredCommitSha: targetDeployment.commitSha,
          updatedAt: new Date(),
        })
        .where(eq(environments.id, environment.id));

      await tx.insert(outboxMessages).values({
        messageType: "deployment.requested",
        aggregateType: "deployment",
        aggregateId: rollback.id,
        dedupeKey: `deployment.requested:${rollback.id}`,
        payload: {
          deploymentId: rollback.id,
        },
        queueName: "deployment",
        status: "pending",
      });

      return rollback;
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (isUniqueViolation(error)) {
      throw new AppError(
        "Another deployment is already active for this environment",
        409,
      );
    }

    throw error;
  }
};
