import axios from "@/api/axios";

import type {
  CreateSecretInput,
  DeleteSecretResponse,
  SecretResponse,
  SecretsResponse,
  UpdateSecretInput,
} from "../types/secret";

export const getProjectSecrets = async (
  projectId: string,
): Promise<SecretsResponse> => {
  const response = await axios.get<SecretsResponse>(
    `/projects/${projectId}/secrets`,
  );

  return response.data;
};

export const getProjectSecret = async (
  projectId: string,
  secretId: string,
): Promise<SecretResponse> => {
  const response = await axios.get<SecretResponse>(
    `/projects/${projectId}/secrets/${secretId}`,
  );

  return response.data;
};

export const createProjectSecret = async (
  projectId: string,
  data: CreateSecretInput,
): Promise<SecretResponse> => {
  const response = await axios.post<SecretResponse>(
    `/projects/${projectId}/secrets`,
    data,
  );

  return response.data;
};

export const updateProjectSecret = async (
  projectId: string,
  secretId: string,
  data: UpdateSecretInput,
): Promise<SecretResponse> => {
  const response = await axios.patch<SecretResponse>(
    `/projects/${projectId}/secrets/${secretId}`,
    data,
  );

  return response.data;
};

export const deleteProjectSecret = async (
  projectId: string,
  secretId: string,
): Promise<DeleteSecretResponse> => {
  const response =
    await axios.delete<DeleteSecretResponse>(
      `/projects/${projectId}/secrets/${secretId}`,
    );

  return response.data;
};

/* -------------------------------------------------------------------------- */
/* Environment-scoped secrets                                                 */
/* -------------------------------------------------------------------------- */

export const getEnvironmentSecrets = async (
  projectId: string,
  environmentId: string,
): Promise<SecretsResponse> => {
  const response = await axios.get<SecretsResponse>(
    `/projects/${projectId}/environments/${environmentId}/secrets`,
  );

  return response.data;
};

export const getEnvironmentSecret = async (
  projectId: string,
  environmentId: string,
  secretId: string,
): Promise<SecretResponse> => {
  const response = await axios.get<SecretResponse>(
    `/projects/${projectId}/environments/${environmentId}/secrets/${secretId}`,
  );

  return response.data;
};

export const createEnvironmentSecret = async (
  projectId: string,
  environmentId: string,
  data: CreateSecretInput,
): Promise<SecretResponse> => {
  const response = await axios.post<SecretResponse>(
    `/projects/${projectId}/environments/${environmentId}/secrets`,
    data,
  );

  return response.data;
};

export const updateEnvironmentSecret = async (
  projectId: string,
  environmentId: string,
  secretId: string,
  data: UpdateSecretInput,
): Promise<SecretResponse> => {
  const response = await axios.patch<SecretResponse>(
    `/projects/${projectId}/environments/${environmentId}/secrets/${secretId}`,
    data,
  );

  return response.data;
};

export const deleteEnvironmentSecret = async (
  projectId: string,
  environmentId: string,
  secretId: string,
): Promise<DeleteSecretResponse> => {
  const response =
    await axios.delete<DeleteSecretResponse>(
      `/projects/${projectId}/environments/${environmentId}/secrets/${secretId}`,
    );

  return response.data;
};