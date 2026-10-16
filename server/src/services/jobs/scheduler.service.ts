import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { jobDependencies, jobs } from "../../db/schema.js";

type RunnableJob = { id: string; key: string };
export type ScheduleRunResult = { runnableJobs: RunnableJob[] };

const TERMINAL_NON_SUCCESS = new Set(["failed", "cancelled", "skipped"]);

/**
 * Resolve runnable jobs and propagate dependency failures. A job whose
 * prerequisite failed must be marked skipped (including transitive dependents),
 * otherwise the run can remain blocked forever.
 */
export const scheduleRunnableJobs = async (runId: string): Promise<ScheduleRunResult> => {
  return db.transaction(async (tx) => {
    const allJobs = await tx
      .select({ id: jobs.id, key: jobs.key, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.runId, runId));

    if (allJobs.length === 0) return { runnableJobs: [] };

    const dependencyRows = await tx
      .select({ jobId: jobDependencies.jobId, dependsOnJobId: jobDependencies.dependsOnJobId })
      .from(jobDependencies)
      .where(eq(jobDependencies.runId, runId));

    const dependenciesByJob = new Map<string, string[]>();
    for (const row of dependencyRows) {
      const values = dependenciesByJob.get(row.jobId) ?? [];
      values.push(row.dependsOnJobId);
      dependenciesByJob.set(row.jobId, values);
    }

    const statuses = new Map(allJobs.map((job) => [job.id, job.status as string]));
    const keys = new Map(allJobs.map((job) => [job.id, job.key]));

    // Iterate to a fixed point so failure propagation handles A -> B -> C.
    let changed = true;
    while (changed) {
      changed = false;
      const skippedIds = allJobs
        .filter((job) => statuses.get(job.id) === "blocked")
        .filter((job) => (dependenciesByJob.get(job.id) ?? []).some((dependencyId) =>
          TERMINAL_NON_SUCCESS.has(statuses.get(dependencyId) ?? ""),
        ))
        .map((job) => job.id);

      if (skippedIds.length > 0) {
        await tx.update(jobs)
          .set({ status: "skipped", errorCode: "DEPENDENCY_FAILED", errorMessage: "A required dependency did not succeed", finishedAt: new Date() })
          .where(and(eq(jobs.runId, runId), eq(jobs.status, "blocked"), inArray(jobs.id, skippedIds)));
        for (const id of skippedIds) statuses.set(id, "skipped");
        changed = true;
      }
    }

    const newlyQueuedIds = allJobs
      .filter((job) => statuses.get(job.id) === "blocked")
      .filter((job) => (dependenciesByJob.get(job.id) ?? []).every((dependencyId) =>
        statuses.get(dependencyId) === "success",
      ))
      .map((job) => job.id);

    if (newlyQueuedIds.length > 0) {
      await tx.update(jobs)
        .set({ status: "queued" })
        .where(and(eq(jobs.runId, runId), eq(jobs.status, "blocked"), inArray(jobs.id, newlyQueuedIds)));
      for (const id of newlyQueuedIds) statuses.set(id, "queued");
    }

    return {
      runnableJobs: allJobs
        .filter((job) => statuses.get(job.id) === "queued")
        .map((job) => ({ id: job.id, key: keys.get(job.id) ?? job.key })),
    };
  });
};
