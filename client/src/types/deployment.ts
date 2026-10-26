import type { Run } from "./run";

export type DeploymentTargetType = "ssh_ec2" | "s3";

export type DeploymentStatus =
  | "queued"
  | "deploying"
  | "verifying"
  | "success"
  | "failed"
  | "cancelled"
  | "superseded";

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  targetType: DeploymentTargetType;
  targetConfig: Record<string, unknown>;
  deploymentBranch: string;
  healthCheckUrl: string | null;
  healthCheckTimeoutSeconds: number;
  desiredRunId: string | null;
  desiredCommitSha: string | null;
  currentCommitSha: string | null;
  currentReleaseRef: string | null;
  currentImageId: string | null;
  currentArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  id: string;
  runId: string | null;
  environmentId: string;
  rollbackToDeploymentId: string | null;
  containerImageId: string | null;
  artifactId: string | null;
  action: "deploy" | "rollback";
  status: DeploymentStatus;
  commitSha: string;
  previousCommitSha: string | null;
  releaseRef: string;
  previousReleaseRef: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnvironmentInput {
  name: string;
  slug: string;
  targetType: DeploymentTargetType;
  targetConfig: Record<string, unknown>;
  deploymentBranch: string;
  healthCheckUrl?: string | null;
  healthCheckTimeoutSeconds?: number;
}

export interface UpdateEnvironmentInput {
  name?: string;
  slug?: string;
  targetType?: DeploymentTargetType;
  targetConfig?: Record<string, unknown>;
  deploymentBranch?: string;
  healthCheckUrl?: string | null;
  healthCheckTimeoutSeconds?: number;
}

export interface CreateDeploymentInput {
  runId: string;
  artifactId?: string;
  containerImageId?: string;
}

export interface DeploymentGateEvaluation {
  eligible: boolean;
  run: Run;
  reason:
    | "eligible"
    | "not_latest_successful_run"
    | "newer_run_pending"
    | "already_deployed"
    | "run_not_successful";
  newerPendingRunId?: string;
  latestSuccessfulDeploymentRunId?: string;
}

export interface EnvironmentsResponse {
  success: boolean;
  message: string;
  data: {
    environments: Environment[];
  };
}

export interface EnvironmentResponse {
  success: boolean;
  message: string;
  data: {
    environment: Environment;
  };
}

export interface DeploymentsResponse {
  success: boolean;
  message: string;
  data: {
    deployments: Deployment[];
  };
}

export interface DeploymentResponse {
  success: boolean;
  message: string;
  data: {
    deployment: Deployment;
  };
}