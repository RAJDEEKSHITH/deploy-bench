import axios from "./axios";
import type {
  CreateDeploymentInput,
  CreateEnvironmentInput,
  DeploymentResponse,
  DeploymentsResponse,
  EnvironmentResponse,
  EnvironmentsResponse,
  UpdateEnvironmentInput,
} from "@/types/deployment";

export const getProjectEnvironments = async (
  projectId: string,
): Promise<EnvironmentsResponse> => {
  const response = await axios.get<EnvironmentsResponse>(
    `/projects/${projectId}/environments`,
  );
  return response.data;
};

export const createProjectEnvironment = async (
  projectId: string,
  data: CreateEnvironmentInput,
): Promise<EnvironmentResponse> => {
  const response = await axios.post<EnvironmentResponse>(
    `/projects/${projectId}/environments`,
    data,
  );
  return response.data;
};

export const updateProjectEnvironment = async (
  projectId: string,
  environmentId: string,
  data: UpdateEnvironmentInput,
): Promise<EnvironmentResponse> => {
  const response = await axios.patch<EnvironmentResponse>(
    `/projects/${projectId}/environments/${environmentId}`,
    data,
  );
  return response.data;
};

export const deleteProjectEnvironment = async (
  projectId: string,
  environmentId: string,
): Promise<{ success: boolean; message: string }> => {
  const response = await axios.delete<{ success: boolean; message: string }>(
    `/projects/${projectId}/environments/${environmentId}`,
  );
  return response.data;
};

export const getEnvironmentDeployments = async (
  environmentId: string,
): Promise<DeploymentsResponse> => {
  const response = await axios.get<DeploymentsResponse>(
    `/environments/${environmentId}/deployments`,
  );
  return response.data;
};

export const triggerEnvironmentDeployment = async (
  environmentId: string,
  data: CreateDeploymentInput,
): Promise<DeploymentResponse> => {
  const response = await axios.post<DeploymentResponse>(
    `/environments/${environmentId}/deployments`,
    data,
  );
  return response.data;
};

export const rollbackEnvironmentDeployment = async (
  environmentId: string,
  targetDeploymentId?: string,
): Promise<DeploymentResponse> => {
  const response = await axios.post<DeploymentResponse>(
    `/environments/${environmentId}/rollback`,
    targetDeploymentId ? { targetDeploymentId } : {},
  );
  return response.data;
};