import type { Job, JobAttempt, JobDependency } from "./job";

export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "superseded";

export type RunTrigger = "push" | "manual" | "retry";

export interface Run {
  id: string;
  projectId: string;
  pipelineVersionId: string;
  webhookDeliveryId: string | null;
  commitSha: string;
  branch: string;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  supersededAt: string | null;
  supersededByRunId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineVersion {
  id: string;
  projectId: string;
  path: string;
  configHash: string;
  commitSha: string;
  rawYaml: string;
  normalizedYaml: Record<string, unknown> | null;
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  createdAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  name: string;
  kind: "archive" | "file";
  contentType: string | null;
  producerJobId: string | null;
  producerJobAttemptId: string | null;
  status: "uploading" | "ready" | "failed" | "expired" | "deleted";
  sha256: string | null;
  s3BucketName: string;
  objectKey: string;
  sizeInBytes: number | null;
  expiresAt: string | null;
  uploadedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ContainerImage {
  id: string;
  name: string;
  runId: string;
  tag: string;
  digest: string;
  producerJobId: string | null;
  producerJobAttemptId: string | null;
  registry: string;
  repository: string;
  createdAt: string;
}

export interface TriggerManualRunInput {
  branch?: string;
  commitSha?: string;
  rawYaml?: string;
}

export interface RunsResponse {
  success: boolean;
  message: string;
  data: {
    runs: Run[];
  };
}

export interface RunResponse {
  success: boolean;
  message: string;
  data: {
    run: Run;
  };
}

export interface RunDetailsResponse {
  success: boolean;
  message: string;
  data: {
    run: Run;
    pipelineVersion: PipelineVersion | null;
    jobs: Job[];
    dependencies: JobDependency[];
    attempts: JobAttempt[];
    artifacts: Artifact[];
    containerImages: ContainerImage[];
  };
}