import type { Artifact, ContainerImage } from "./run";

export type JobStatus =
  | "blocked"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "skipped";

export type JobAttemptStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface Job {
  id: string;
  runId: string;
  key: string;
  name: string;
  definition: Record<string, unknown>;
  status: JobStatus;
  allowFailure: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  timeoutSeconds: number;
  maxAttempts: number;
  startedAt: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobDependency {
  id: string;
  runId: string;
  jobId: string;
  dependsOnJobId: string;
}

export interface JobAttempt {
  id: string;
  jobId: string;
  attemptNumber: number;
  status: JobAttemptStatus;
  queueName: string;
  queueJobId: string | null;
  failureClass: string | null;
  retryable: boolean | null;
  stepResults: Record<string, unknown>[] | null;
  startedAt: string | null;
  containerId: string | null;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogStream {
  id: string;
  jobAttemptId: string;
  streamType: "stdout" | "stderr" | "system";
  status: "open" | "completed" | "failed";
  s3Bucket: string;
  s3Prefix: string;
  totalBytes: number;
  totalLines: number;
  lastSequence: number;
  createdAt: string;
  closedAt: string | null;
}

export interface LogLineEntry {
  id: string;
  streamType: "stdout" | "stderr" | "system";
  timestamp: string;
  text: string;
  sequence?: number;
}

export interface RunJobsResponse {
  success: boolean;
  message: string;
  data: {
    jobs: Job[];
    dependencies: JobDependency[];
    attempts: JobAttempt[];
  };
}

export interface JobDetailsResponse {
  success: boolean;
  message: string;
  data: {
    job: Job;
    dependencies: JobDependency[];
    attempts: JobAttempt[];
    logStreams: LogStream[];
    artifacts: Artifact[];
    containerImages: ContainerImage[];
  };
}