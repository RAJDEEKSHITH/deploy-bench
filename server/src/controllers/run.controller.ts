import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  artifacts,
  branchHeads,
  containerImages,
  jobAttempts,
  jobDependencies,
  jobs,
  pipelineVersions,
  projects,
  runs,
} from "../db/schema.js";
import { AppError } from "../utils/app.error.js";
import type {
  ProjectRunsParams,
  RunIdParams,
  TriggerManualRunInput,
} from "../validators/run.validator.js";
import {
  processPipelineVersion,
  processRawPipelineVersion,
  type ProcessPipelineVersionResult,
} from "../services/pipeline/pipeline-version.service.js";
import { getGithubAccessTokenForProject } from "../services/github/github-access-token.service.js";
import { createRun } from "../services/runs/run.service.js";
import { createJobsForRun } from "../services/jobs/job.service.js";
import { advanceRun } from "../services/runs/run-orchestrator.service.js";

const verifyProjectAccess = async (projectId: string, userId: string) => {
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

const verifyRunAccess = async (runId: string, userId: string) => {
  const [row] = await db
    .select({
      run: runs,
      project: projects,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(projects.createdById, userId)))
    .limit(1);

  if (!row) {
    throw new AppError("Run not found", 404);
  }

  return row;
};

export const listProjectRuns = async (
  req: Request<ProjectRunsParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectAccess(req.params.projectId, req.user!.id);

    const branchFilter =
      typeof req.query.branch === "string" && req.query.branch.trim().length > 0
        ? req.query.branch.trim()
        : undefined;

    const statusFilter =
      typeof req.query.status === "string" && req.query.status.trim().length > 0
        ? (req.query.status.trim() as typeof runs.$inferSelect.status)
        : undefined;

    const conditions = [eq(runs.projectId, req.params.projectId)];
    if (branchFilter) {
      conditions.push(eq(runs.branch, branchFilter));
    }
    if (statusFilter) {
      conditions.push(eq(runs.status, statusFilter));
    }

    const projectRuns = await db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(50);

    return res.status(200).json({
      success: true,
      message: "Runs fetched successfully",
      data: {
        runs: projectRuns,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const triggerManualRun = async (
  req: Request<ProjectRunsParams, unknown, TriggerManualRunInput>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const project = await verifyProjectAccess(req.params.projectId, req.user!.id);
    const branch = req.body.branch?.trim() || project.defaultBranch;

    let commitSha = req.body.commitSha?.trim().toLowerCase();
    if (!commitSha) {
      const [branchHead] = await db
        .select({ commitSha: branchHeads.commitSha, isDeleted: branchHeads.isDeleted })
        .from(branchHeads)
        .where(and(eq(branchHeads.projectId, project.id), eq(branchHeads.branch, branch)))
        .limit(1);
      if (!branchHead || branchHead.isDeleted) {
        throw new AppError(
          `No observed commit exists for branch "${branch}". Push that branch or provide a full commit SHA.`,
          409,
        );
      }
      commitSha = branchHead.commitSha.toLowerCase();
    }

    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) {
      throw new AppError("Commit SHA must be a full 40- or 64-character hexadecimal SHA", 400);
    }

    let pipeline: ProcessPipelineVersionResult;
    if (req.body.rawYaml !== undefined) {
      const rawYaml = req.body.rawYaml;
      const hash = createHash("sha256").update(rawYaml, "utf8").digest("hex");
      // Keep custom/manual pipeline definitions separate from the committed pipeline
      // version for this exact commit. A manual config is still immutable/auditable.
      pipeline = await processRawPipelineVersion({
        projectId: project.id,
        commitSha,
        pipelinePath: `.cicd/manual-${hash.slice(0, 32)}.yaml`,
        rawYaml,
      });
    } else {
      pipeline = await processPipelineVersion({
        projectId: project.id,
        commitSha,
        pipelinePath: project.pipelinePath,
        repositoryUrl: project.repositoryUrl,
        accessToken: await getGithubAccessTokenForProject(project.id),
      });
    }

    const created = await createRun({
      projectId: project.id,
      pipelineVersionId: pipeline.pipelineVersionId,
      commitSha,
      branch,
      trigger: "manual",
    });

    if (pipeline.validationStatus === "invalid") {
      await db.update(runs).set({
        status: "failed",
        errorCode: "PIPELINE_INVALID",
        errorMessage: pipeline.validationError ?? "Pipeline validation failed",
        startedAt: new Date(),
        finishedAt: new Date(),
      }).where(and(eq(runs.id, created.runId), eq(runs.status, "queued")));
    } else {
      await createJobsForRun(created.runId);
      await advanceRun(created.runId);
    }

    const [run] = await db.select().from(runs).where(eq(runs.id, created.runId)).limit(1);
    return res.status(201).json({
      success: true,
      message: pipeline.validationStatus === "invalid"
        ? "Run created but failed pipeline validation"
        : "Run triggered successfully",
      data: { run, validationError: pipeline.validationError },
    });
  } catch (error) {
    next(error);
  }
};

export const getRunDetails = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);

    const [pipelineVersion] = await db
      .select()
      .from(pipelineVersions)
      .where(eq(pipelineVersions.id, run.pipelineVersionId))
      .limit(1);

    const runJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.runId, run.id))
      .orderBy(asc(jobs.createdAt), asc(jobs.key));

    const dependencies = await db
      .select()
      .from(jobDependencies)
      .where(eq(jobDependencies.runId, run.id));

    const jobIds = runJobs.map((j) => j.id);
    const attempts =
      jobIds.length > 0
        ? await db
            .select()
            .from(jobAttempts)
            .where(inArray(jobAttempts.jobId, jobIds))
            .orderBy(desc(jobAttempts.attemptNumber))
        : [];

    const runArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .orderBy(desc(artifacts.createdAt));

    const runImages = await db
      .select()
      .from(containerImages)
      .where(eq(containerImages.runId, run.id))
      .orderBy(desc(containerImages.createdAt));

    return res.status(200).json({
      success: true,
      message: "Run details fetched successfully",
      data: {
        run,
        pipelineVersion: pipelineVersion ?? null,
        jobs: runJobs,
        dependencies,
        attempts,
        artifacts: runArtifacts,
        containerImages: runImages,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const cancelRun = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);

    if (
      run.status === "success" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "superseded"
    ) {
      throw new AppError(`Run cannot be cancelled while in '${run.status}' status`, 409);
    }

    const now = new Date();

    const updatedRun = await db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(runs)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();

      const activeJobs = await tx
        .update(jobs)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.runId, run.id),
            inArray(jobs.status, ["blocked", "queued", "running"]),
          ),
        )
        .returning({ id: jobs.id });

      const activeJobIds = activeJobs.map((j) => j.id);
      if (activeJobIds.length > 0) {
        await tx
          .update(jobAttempts)
          .set({
            status: "cancelled",
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(jobAttempts.jobId, activeJobIds),
              inArray(jobAttempts.status, ["queued", "running"]),
            ),
          );
      }

      return cancelled ?? run;
    });

    return res.status(200).json({
      success: true,
      message: "Run cancelled successfully",
      data: {
        run: updatedRun,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const retryRun = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);
    const [pipelineVersion] = await db
      .select()
      .from(pipelineVersions)
      .where(eq(pipelineVersions.id, run.pipelineVersionId))
      .limit(1);

    if (
      !pipelineVersion ||
      pipelineVersion.validationStatus !== "valid" ||
      !pipelineVersion.normalizedYaml
    ) {
      throw new AppError("Pipeline version not found or invalid for retry", 409);
    }

    const created = await createRun({
      projectId: run.projectId,
      pipelineVersionId: pipelineVersion.id,
      commitSha: run.commitSha,
      branch: run.branch,
      trigger: "retry",
    });
    await createJobsForRun(created.runId);
    await advanceRun(created.runId);

    const [retriedRun] = await db.select().from(runs).where(eq(runs.id, created.runId)).limit(1);
    return res.status(201).json({
      success: true,
      message: "Run retry queued successfully",
      data: { run: retriedRun },
    });
  } catch (error) {
    next(error);
  }
};
