import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobDependencies,
  jobs,
  outboxMessages,
} from "../../db/schema.js";
import { JOB_NAMES, QUEUE_NAMES } from "../../queues/queue-names.js";
import { AppError } from "../../utils/app.error.js";

export type CreateJobAttemptResult = {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  status: "queued";
};

export const createJobAttempt = async (
  jobId: string,
): Promise<CreateJobAttemptResult> => {
  return db.transaction(async (tx) => {
    /*
     * Lock the logical job row.
     *
     * This serializes two concurrent requests trying to create an
     * attempt for the same job.
     */
    const [job] = await tx
      .select({
        id: jobs.id,
        runId: jobs.runId,
        status: jobs.status,
        maxAttempts: jobs.maxAttempts,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .for("update")
      .limit(1);

    if (!job) {
      throw new AppError("Job not found", 404);
    }

    /*
     * Only a queued logical job can be turned into a physical attempt.
     */
    if (job.status !== "queued") {
      throw new AppError(
        "Job is not currently queued for execution",
        409,
      );
    }

    /*
     * Verify that all dependencies have succeeded.
     *
     * Jobs with no dependency rows pass automatically.
     */
    const dependencyRows = await tx
      .select({
        status: jobs.status,
      })
      .from(jobDependencies)
      .innerJoin(
        jobs,
        eq(jobDependencies.dependsOnJobId, jobs.id),
      )
      .where(
        and(
          eq(jobDependencies.jobId, job.id),
          eq(jobDependencies.runId, job.runId),
        ),
      );

    const dependenciesSucceeded = dependencyRows.every(
      (dependency) => dependency.status === "success",
    );

    if (!dependenciesSucceeded) {
      throw new AppError(
        "Job dependencies have not all succeeded",
        409,
      );
    }

    /*
     * Determine the next physical attempt number.
     *
     * The logical jobs table does not store currentAttempt.
     * attemptNumber is derived from the durable attempt history.
     */
    const [latestAttempt] = await tx
      .select({
        maxAttemptNumber: sql<number>`
          COALESCE(MAX(${jobAttempts.attemptNumber}), 0)
        `,
      })
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, job.id));

    const attemptNumber =
      (latestAttempt?.maxAttemptNumber ?? 0) + 1;

    if (attemptNumber > job.maxAttempts) {
      throw new AppError(
        "Job has exhausted its maximum attempts",
        409,
      );
    }

    const [attempt] = await tx
      .insert(jobAttempts)
      .values({
        jobId: job.id,
        attemptNumber,
        status: "queued",
        queueName: QUEUE_NAMES.jobAttempt,
      })
      .returning({
        id: jobAttempts.id,
        jobId: jobAttempts.jobId,
        attemptNumber: jobAttempts.attemptNumber,
        status: jobAttempts.status,
      });

    if (!attempt) {
      throw new AppError(
        "Failed to create job attempt",
        500,
      );
    }

    // The durable attempt and its queue request must commit atomically.
    // The outbox publisher will turn this row into a BullMQ message.
    await tx
      .insert(outboxMessages)
      .values({
        messageType: JOB_NAMES.jobAttempt,
        aggregateType: "job_attempt",
        aggregateId: attempt.id,
        dedupeKey: `job-attempt:${attempt.id}`,
        payload: {
          jobAttemptId: attempt.id,
          jobId: job.id,
          runId: job.runId,
        },
        queueName: QUEUE_NAMES.jobAttempt,
        status: "pending",
      })
      .onConflictDoNothing({ target: outboxMessages.dedupeKey });

    /*
     * Move the logical job to running only after the attempt exists.
     *
     * The whole operation is one transaction, so either both changes
     * commit or neither does.
     */
    const [updatedJob] = await tx
      .update(jobs)
      .set({
        status: "running",
        startedAt: sql`COALESCE(${jobs.startedAt}, NOW())`,
      })
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, "queued"),
        ),
      )
      .returning({
        id: jobs.id,
      });

    if (!updatedJob) {
      throw new AppError(
        "Job state changed while creating attempt",
        409,
      );
    }

    return {
      attemptId: attempt.id,
      jobId: attempt.jobId,
      attemptNumber: attempt.attemptNumber,
      status: "queued",
    };
  });
};


