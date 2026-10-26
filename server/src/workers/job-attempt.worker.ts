import type { Job } from "bullmq";
import {
  executeJobAttempt,
} from "../services/execution/execution.service.js";
import { advanceRunForAttempt } from "../services/runs/run-orchestrator.service.js";

export const JOB_ATTEMPT_QUEUE_NAME = "job-attempt";

export type JobAttemptQueueData = {
  jobAttemptId: string;
};

export const processJobAttempt = async (
  job: Job<JobAttemptQueueData>,
) => {
  const { jobAttemptId } = job.data;

  if (
    typeof jobAttemptId !== "string" ||
    jobAttemptId.length === 0
  ) {
    throw new Error(
      "Invalid job attempt queue payload",
    );
  }

  if (!job.id) {
    throw new Error(
      "BullMQ job does not have an ID",
    );
  }

  const result = await executeJobAttempt({
    attemptId: jobAttemptId,
    queueJobId: String(job.id),
  });

  // Every attempt outcome may unblock dependents, queue a retry, or finish
  // the run. Run state is derived from PostgreSQL rather than BullMQ state.
  await advanceRunForAttempt(jobAttemptId);
  return result;
};


