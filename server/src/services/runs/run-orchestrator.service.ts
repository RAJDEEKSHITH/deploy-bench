import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { jobAttempts, jobs, runs } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { createJobAttempt } from "../jobs/job-attempt.service.js";
import { scheduleRunnableJobs } from "../jobs/scheduler.service.js";

const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "cancelled", "superseded"]);
const ACTIVE_JOB_STATUSES = new Set(["blocked", "queued", "running"]);

/** Create durable attempts for runnable jobs and close the run when all jobs settle. */
export const advanceRun = async (runId: string): Promise<void> => {
  const [run] = await db.select({ id: runs.id, status: runs.status })
    .from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;

  await db.update(runs)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")));

  const scheduled = await scheduleRunnableJobs(runId);
  for (const job of scheduled.runnableJobs) {
    try {
      await createJobAttempt(job.id);
    } catch (error) {
      // The run can be advanced by multiple completion events concurrently.
      // A conflict means another caller already created this job's attempt.
      if (error instanceof AppError && error.statusCode === 409) continue;
      throw error;
    }
  }

  const runJobs = await db.select({
    id: jobs.id,
    status: jobs.status,
    allowFailure: jobs.allowFailure,
    errorMessage: jobs.errorMessage,
  }).from(jobs).where(eq(jobs.runId, runId));

  if (runJobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))) return;

  const failed = runJobs.filter((job) => job.status === "failed" && !job.allowFailure);
  const cancelled = runJobs.some((job) => job.status === "cancelled");
  const skipped = runJobs.some((job) => job.status === "skipped");
  const status = cancelled ? "cancelled" : failed.length > 0 || skipped ? "failed" : "success";
  const errorMessage = failed[0]?.errorMessage ?? (skipped ? "One or more jobs were skipped because a dependency failed" : null);

  await db.update(runs).set({
    status,
    finishedAt: new Date(),
    errorCode: status === "failed" ? (skipped && failed.length === 0 ? "DEPENDENCY_FAILED" : "JOB_FAILED") : null,
    errorMessage,
  }).where(and(eq(runs.id, runId), eq(runs.status, "running")));
};

export const advanceRunForAttempt = async (attemptId: string): Promise<void> => {
  const [row] = await db.select({ runId: jobs.runId })
    .from(jobAttempts)
    .innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
    .where(eq(jobAttempts.id, attemptId))
    .limit(1);
  if (!row) throw new AppError("Job attempt not found while advancing run", 404);
  await advanceRun(row.runId);
};
