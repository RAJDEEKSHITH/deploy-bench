import type { NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  deployments,
  environments,
  outboxMessages,
  projects,
} from "../db/schema.js";
import {
  checkDeploymentEligibility,
  createDeployment,
  createEnvironment,
  getDeployment,
  getEnvironment,
  listDeploymentHistory,
  updateEnvironment,
} from "../services/deployments/deployment.service.js";
import { JOB_NAMES, QUEUE_NAMES } from "../queues/queue-names.js";
import { AppError } from "../utils/app.error.js";
import type {
  CreateDeploymentBody,
  CreateEnvironmentBody,
  RollbackDeploymentBody,
  UpdateEnvironmentBody,
} from "../validators/deployment.validator.js";

const verifyProjectOwnership = async (projectId: string, userId: string) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.createdById, userId)))
    .limit(1);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  return project;
};

const verifyEnvironmentOwnership = async (
  environmentId: string,
  userId: string,
) => {
  const [row] = await db
    .select({
      environment: environments,
      project: projects,
    })
    .from(environments)
    .innerJoin(projects, eq(environments.projectId, projects.id))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(projects.createdById, userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AppError("Environment not found", 404);
  }

  return row.environment;
};

export const listProjectEnvironments = async (
  req: Request<{ projectId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectOwnership(req.params.projectId, req.user!.id);

    const list = await db
      .select()
      .from(environments)
      .where(eq(environments.projectId, req.params.projectId))
      .orderBy(asc(environments.createdAt));

    return res.status(200).json({
      success: true,
      message: "Environments fetched successfully",
      data: {
        environments: list,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createProjectEnvironment = async (
  req: Request<{ projectId: string }, unknown, CreateEnvironmentBody>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectOwnership(req.params.projectId, req.user!.id);

    const environment = await createEnvironment({
      projectId: req.params.projectId,
      name: req.body.name,
      slug: req.body.slug,
      targetType: req.body.targetType,
      targetConfig: req.body.targetConfig,
      deploymentBranch: req.body.deploymentBranch,
      ...(req.body.healthCheckUrl !== undefined
        ? { healthCheckUrl: req.body.healthCheckUrl }
        : {}),
      ...(req.body.healthCheckTimeoutSeconds !== undefined
        ? { healthCheckTimeoutSeconds: req.body.healthCheckTimeoutSeconds }
        : {}),
    });

    return res.status(201).json({
      success: true,
      message: "Environment created successfully",
      data: {
        environment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getProjectEnvironment = async (
  req: Request<{ projectId: string; environmentId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectOwnership(req.params.projectId, req.user!.id);
    const environment = await getEnvironment(req.params.environmentId);

    if (environment.projectId !== req.params.projectId) {
      throw new AppError("Environment not found in this project", 404);
    }

    return res.status(200).json({
      success: true,
      message: "Environment fetched successfully",
      data: {
        environment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateProjectEnvironment = async (
  req: Request<
    { projectId: string; environmentId: string },
    unknown,
    UpdateEnvironmentBody
  >,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectOwnership(req.params.projectId, req.user!.id);
    const existing = await getEnvironment(req.params.environmentId);

    if (existing.projectId !== req.params.projectId) {
      throw new AppError("Environment not found in this project", 404);
    }

    const environment = await updateEnvironment({
      environmentId: req.params.environmentId,
      ...(req.body.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body.slug !== undefined ? { slug: req.body.slug } : {}),
      ...(req.body.targetType !== undefined
        ? { targetType: req.body.targetType }
        : {}),
      ...(req.body.targetConfig !== undefined
        ? { targetConfig: req.body.targetConfig }
        : {}),
      ...(req.body.deploymentBranch !== undefined
        ? { deploymentBranch: req.body.deploymentBranch }
        : {}),
      ...(req.body.healthCheckUrl !== undefined
        ? { healthCheckUrl: req.body.healthCheckUrl }
        : {}),
      ...(req.body.healthCheckTimeoutSeconds !== undefined
        ? { healthCheckTimeoutSeconds: req.body.healthCheckTimeoutSeconds }
        : {}),
    });

    return res.status(200).json({
      success: true,
      message: "Environment updated successfully",
      data: {
        environment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deleteProjectEnvironment = async (
  req: Request<{ projectId: string; environmentId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectOwnership(req.params.projectId, req.user!.id);
    const existing = await getEnvironment(req.params.environmentId);

    if (existing.projectId !== req.params.projectId) {
      throw new AppError("Environment not found in this project", 404);
    }

    await db
      .delete(environments)
      .where(eq(environments.id, req.params.environmentId));

    return res.status(200).json({
      success: true,
      message: "Environment deleted successfully",
      data: {
        environmentId: existing.id,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const checkEnvironmentDeploymentEligibility = async (
  req: Request<{ environmentId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyEnvironmentOwnership(req.params.environmentId, req.user!.id);

    const runId = req.query.runId;
    if (typeof runId !== "string" || !runId.trim()) {
      throw new AppError("Query parameter 'runId' is required", 400);
    }

    const evaluation = await checkDeploymentEligibility({
      environmentId: req.params.environmentId,
      runId: runId.trim(),
    });

    return res.status(200).json({
      success: true,
      message: "Deployment eligibility evaluated",
      data: {
        evaluation,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listEnvironmentDeployments = async (
  req: Request<{ environmentId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyEnvironmentOwnership(req.params.environmentId, req.user!.id);

    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 50;

    const history = await listDeploymentHistory({
      environmentId: req.params.environmentId,
      limit: Number.isInteger(limit) ? limit : 50,
    });

    return res.status(200).json({
      success: true,
      message: "Deployment history fetched successfully",
      data: {
        deployments: history,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const triggerDeployment = async (
  req: Request<{ environmentId: string }, unknown, CreateDeploymentBody>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyEnvironmentOwnership(req.params.environmentId, req.user!.id);

    const deployment = await createDeployment({
      environmentId: req.params.environmentId,
      runId: req.body.runId,
      ...(req.body.artifactId !== undefined
        ? { artifactId: req.body.artifactId }
        : {}),
      ...(req.body.containerImageId !== undefined
        ? { containerImageId: req.body.containerImageId }
        : {}),
    });

    return res.status(201).json({
      success: true,
      message: "Deployment queued successfully",
      data: {
        deployment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getDeploymentById = async (
  req: Request<{ deploymentId: string }>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const deployment = await getDeployment(req.params.deploymentId);
    await verifyEnvironmentOwnership(deployment.environmentId, req.user!.id);

    return res.status(200).json({
      success: true,
      message: "Deployment fetched successfully",
      data: {
        deployment,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const rollbackEnvironmentDeployment = async (
  req: Request<{ environmentId: string }, unknown, RollbackDeploymentBody>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const environment = await verifyEnvironmentOwnership(
      req.params.environmentId,
      req.user!.id,
    );

    const rollbackDeployment = await db.transaction(async (tx) => {
      const [lockedEnv] = await tx
        .select()
        .from(environments)
        .where(eq(environments.id, environment.id))
        .for("update")
        .limit(1);

      if (!lockedEnv) {
        throw new AppError("Environment not found", 404);
      }

      const [activeDeployment] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.environmentId, lockedEnv.id),
            inArray(deployments.status, ["queued", "deploying", "verifying"]),
          ),
        )
        .limit(1);

      if (activeDeployment) {
        throw new AppError(
          "Cannot rollback while another deployment is active on this environment",
          409,
        );
      }

      let targetDeployment: typeof deployments.$inferSelect | undefined;

      if (req.body.targetDeploymentId) {
        const [found] = await tx
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.id, req.body.targetDeploymentId),
              eq(deployments.environmentId, lockedEnv.id),
              eq(deployments.status, "success"),
            ),
          )
          .limit(1);
        targetDeployment = found;
      } else {
        const [found] = await tx
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.environmentId, lockedEnv.id),
              eq(deployments.status, "success"),
              ...(lockedEnv.currentReleaseRef
                ? [ne(deployments.releaseRef, lockedEnv.currentReleaseRef)]
                : []),
            ),
          )
          .orderBy(desc(deployments.createdAt), desc(deployments.id))
          .limit(1);
        targetDeployment = found;
      }

      if (!targetDeployment) {
        throw new AppError(
          "No previous successful deployment found to roll back to",
          404,
        );
      }

      const [created] = await tx
        .insert(deployments)
        .values({
          runId: targetDeployment.runId,
          environmentId: lockedEnv.id,
          rollbackToDeploymentId: targetDeployment.id,
          containerImageId: targetDeployment.containerImageId,
          artifactId: targetDeployment.artifactId,
          action: "rollback",
          status: "queued",
          commitSha: targetDeployment.commitSha,
          previousCommitSha: lockedEnv.currentCommitSha,
          releaseRef: targetDeployment.releaseRef,
          previousReleaseRef: lockedEnv.currentReleaseRef,
        })
        .returning();

      if (!created) {
        throw new AppError("Failed to create rollback deployment", 500);
      }

      await tx.insert(outboxMessages).values({
        messageType: JOB_NAMES.deployment,
        aggregateType: "deployment",
        aggregateId: created.id,
        dedupeKey: `deployment.requested:${created.id}`,
        payload: {
          deploymentId: created.id,
        },
        queueName: QUEUE_NAMES.deployment,
        status: "pending",
      });

      return created;
    });

    return res.status(201).json({
      success: true,
      message: "Rollback deployment queued successfully",
      data: {
        deployment: rollbackDeployment,
      },
    });
  } catch (error) {
    next(error);
  }
};


