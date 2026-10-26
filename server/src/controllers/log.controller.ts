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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const readLogRouteParams = (
  req: Request,
): { runId: string; jobId: string; userId: string } => {
  const { runId, jobId } = req.params;

  if (
    typeof runId !== "string" ||
    typeof jobId !== "string" ||
    !UUID_REGEX.test(runId) ||
    !UUID_REGEX.test(jobId)
  ) {
    throw new AppError("Invalid run or job ID", 400);
  }

  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }

  return { runId, jobId, userId: req.user.id };
};

/**
 * Verify both the run/job relationship and that the authenticated user owns
 * the project. The SSE endpoint must not be a way to subscribe to another
 * user's Redis log channel by guessing IDs.
 */
const assertJobLogAccess = async ({
  runId,
  jobId,
  userId,
}: {
  runId: string;
  jobId: string;
  userId: string;
}): Promise<void> => {
  const [row] = await db
    .select({ jobId: jobs.id })
    .from(jobs)
    .innerJoin(runs, eq(jobs.runId, runs.id))
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(
      and(
        eq(jobs.id, jobId),
        eq(runs.id, runId),
        eq(projects.createdById, userId),
      ),
    )
    .limit(1);

  if (!row) {
    // Do not reveal whether an inaccessible job ID exists.
    throw new AppError("Job not found", 404);
  }
};

export const streamJobLogsController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const params = readLogRouteParams(req);
    await assertJobLogAccess(params);

    await streamJobLogs({
      response: res,
      runId: params.runId,
      jobId: params.jobId,
    });
  } catch (error) {
    next(error);
  }
};

export const getJobLogsMetadataController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const params = readLogRouteParams(req);
    await assertJobLogAccess(params);

    const attempts = await db
      .select()
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, params.jobId))
      .orderBy(desc(jobAttempts.attemptNumber));

    const attemptIds = attempts.map((attempt) => attempt.id);
    const streams = attemptIds.length > 0
      ? await db
          .select()
          .from(logStreams)
          .where(inArray(logStreams.jobAttemptId, attemptIds))
      : [];

    const streamIds = streams.map((stream) => stream.id);
    const chunks = streamIds.length > 0
      ? await db
          .select()
          .from(logChunks)
          .where(inArray(logChunks.logStreamId, streamIds))
          .orderBy(asc(logChunks.createdAt), asc(logChunks.id))
      : [];

    res.status(200).json({
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
