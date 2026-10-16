import { z } from "zod";

export const runJobsParamSchema = z.object({
  runId: z.uuid("Invalid run ID"),
});

export const runJobIdParamSchema = z.object({
  runId: z.uuid("Invalid run ID"),
  jobId: z.uuid("Invalid job ID"),
});

export type RunJobsParams = z.infer<typeof runJobsParamSchema>;
export type RunJobIdParams = z.infer<typeof runJobIdParamSchema>;