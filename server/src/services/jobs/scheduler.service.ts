import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  jobDependencies,
  jobs,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";

const RUNNABLE_JOB_STATUSES = ["blocked", "queued"] as const;

type RunnableJob = {
  id: string;
  key: string;
};

export type ScheduleRunResult = {
  runnableJobs: RunnableJob[];
};

export const scheduleRunnableJobs = async (
  runId: string,
): Promise<ScheduleRunResult> => {
  return db.transaction(async (tx) => {
    const runJobs = await tx
      .select({
        id: jobs.id,
        key: jobs.key,
        status: jobs.status,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.runId, runId),
          inArray(jobs.status, [...RUNNABLE_JOB_STATUSES]),
        ),
      );

    if (runJobs.length === 0) {
      return { runnableJobs: [] };
    }

    const dependencyRows = await tx
      .select({
        jobId: jobDependencies.jobId,
        dependsOnJobId: jobDependencies.dependsOnJobId,
        dependencyStatus: jobs.status,
      })
      .from(jobDependencies)
      .innerJoin(
        jobs,
        eq(jobDependencies.dependsOnJobId, jobs.id),
      )
      .where(eq(jobDependencies.runId, runId));

    const dependenciesByJob = new Map<
      string,
      Array<{
        dependsOnJobId: string;
        status: typeof jobs.$inferSelect.status;
      }>
    >();

    for (const dependency of dependencyRows) {
      const current = dependenciesByJob.get(dependency.jobId);

      const item = {
        dependsOnJobId: dependency.dependsOnJobId,
        status: dependency.dependencyStatus,
      };

      if (current) {
        current.push(item);
      } else {
        dependenciesByJob.set(dependency.jobId, [item]);
      }
    }

    const newlyQueuedIds: string[] = [];

    for (const job of runJobs) {
      /*
       * A job already queued has already been made runnable.
       * Leave it alone.
       */
      if (job.status === "queued") {
        continue;
      }

      const dependencies =
        dependenciesByJob.get(job.id) ?? [];

      /*
       * No dependencies:
       * runnable immediately.
       */
      const allDependenciesSucceeded =
        dependencies.length === 0 ||
        dependencies.every(
          (dependency) => dependency.status === "success",
        );

      if (!allDependenciesSucceeded) {
        continue;
      }

      newlyQueuedIds.push(job.id);
    }

    if (newlyQueuedIds.length > 0) {
      await tx
        .update(jobs)
        .set({
          status: "queued",
        })
        .where(
          and(
            eq(jobs.runId, runId),
            eq(jobs.status, "blocked"),
            inArray(jobs.id, newlyQueuedIds),
          ),
        );
    }

    const runnableJobs = runJobs
      .filter(
        (job) =>
          job.status === "queued" ||
          newlyQueuedIds.includes(job.id),
      )
      .map((job) => ({
        id: job.id,
        key: job.key,
      }));

    return { runnableJobs };
  });
};