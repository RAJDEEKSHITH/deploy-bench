import type { NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  artifacts,
  containerImages,
  jobAttempts,
  jobDependencies,
  jobs,
  logStreams,
  projects,
  runs,
} from "../db/schema.js";
import { AppError } from "../utils/app.error.js";
import type { RunJobIdParams, RunJobsParams } from "../validators/job.validator.js";

const verifyRunOwnership = async (runId: string, userId: string) => {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(projects.createdById, userId)))
    .limit(1);

  if (!row) {
    throw new AppError("Run not found", 404);
  }

  return row.run;
};

export const listRunJobs = async (
  req: Request<RunJobsParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const run = await verifyRunOwnership(req.params.runId, req.user!.id);

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

    return res.status(200).json({
      success: true,
      message: "Jobs fetched successfully",
      data: {
        jobs: runJobs,
        dependencies,
        attempts,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRunJob = async (
  req: Request<RunJobIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyRunOwnership(req.params.runId, req.user!.id);

    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, req.params.jobId),
          eq(jobs.runId, req.params.runId),
        ),
      )
      .limit(1);

    if (!job) {
      throw new AppError("Job not found", 404);
    }

    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, job.id))
      .orderBy(desc(jobAttempts.attemptNumber));

    const dependencies = await db
      .select()
      .from(jobDependencies)
      .where(eq(jobDependencies.jobId, job.id));

    const attemptIds = attempts.map((a) => a.id);
    const streams =
      attemptIds.length > 0
        ? await db
            .select()
            .from(logStreams)
            .where(inArray(logStreams.jobAttemptId, attemptIds))
        : [];

    const jobArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.producerJobId, job.id));

    const jobImages = await db
      .select()
      .from(containerImages)
      .where(eq(containerImages.producerJobId, job.id));

    return res.status(200).json({
      success: true,
      message: "Job fetched successfully",
      data: {
        job,
        dependencies,
        attempts,
        logStreams: streams,
        artifacts: jobArtifacts,
        containerImages: jobImages,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listJobAttempts = async (
  req: Request<RunJobIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyRunOwnership(req.params.runId, req.user!.id);

    const [job] = await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, req.params.jobId),
          eq(jobs.runId, req.params.runId),
        ),
      )
      .limit(1);

    if (!job) {
      throw new AppError("Job not found", 404);
    }

    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, job.id))
      .orderBy(desc(jobAttempts.attemptNumber));

    return res.status(200).json({
      success: true,
      message: "Job attempts fetched successfully",
      data: {
        attempts,
      },
    });
  } catch (error) {
    next(error);
  }
};