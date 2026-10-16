import type { NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db/index.js";
import {
  jobAttempts,
  jobs,
  logChunks,
  logStreams,
  projects,
  runs,
} from "../db/schema.js";
import { AppError } from "../utils/app.error.js";
import { streamJobLogs } from "../services/logs/log-sse.service.js";

export const streamJobLogsController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { runId, jobId } = req.params;

    if (typeof runId !== "string" || typeof jobId !== "string") {
      throw new AppError("Invalid run or job ID", 400);
    }

    if (!req.user) {
      throw new AppError("Authentication required", 401);
    }

    await streamJobLogs({
      response: res,
      runId,
      jobId,
    });
  } catch (error) {
    next(error);
  }
};

export const getJobLogsMetadataController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { runId, jobId } = req.params;

    if (typeof runId !== "string" || typeof jobId !== "string") {
      throw new AppError("Invalid run or job ID", 400);
    }

    const [row] = await db
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(runs, eq(jobs.runId, runs.id))
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(
        and(
          eq(jobs.id, jobId),
          eq(runs.id, runId),
          eq(projects.createdById, req.user!.id),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError("Job not found", 404);
    }

    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, jobId))
      .orderBy(desc(jobAttempts.attemptNumber));

    const attemptIds = attempts.map((a) => a.id);
    const streams =
      attemptIds.length > 0
        ? await db
            .select()
            .from(logStreams)
            .where(inArray(logStreams.jobAttemptId, attemptIds))
        : [];

    const streamIds = streams.map((s) => s.id);
    const chunks =
      streamIds.length > 0
        ? await db
            .select()
            .from(logChunks)
            .where(inArray(logChunks.logStreamId, streamIds))
            .orderBy(asc(logChunks.sequence))
        : [];

    return res.status(200).json({
      success: true,
      message: "Job log streams fetched",
      data: {
        attempts,
        streams,
        chunks,
      },
    });
  } catch (error) {
    next(error);
  }
};