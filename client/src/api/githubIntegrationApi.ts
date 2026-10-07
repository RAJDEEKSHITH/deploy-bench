import axios from "./axios";

import type {
  CreateGithubIntegrationInput,
  GithubIntegrationResponse,
  UpdateGithubIntegrationInput,
} from "../types/githubIntegration";

export const getGithubIntegration = async (
  projectId: string,
): Promise<GithubIntegrationResponse> => {
  const response =
    await axios.get<GithubIntegrationResponse>(
      `/projects/${projectId}/github-integration`,
    );

  return response.data;
};

export const createGithubIntegration = async (
  projectId: string,
  data: CreateGithubIntegrationInput,
): Promise<GithubIntegrationResponse> => {
  const response =
    await axios.post<GithubIntegrationResponse>(
      `/projects/${projectId}/github-integration`,
      data,
    );

  return response.data;
};

export const updateGithubIntegration = async (
  projectId: string,
  data: UpdateGithubIntegrationInput,
): Promise<GithubIntegrationResponse> => {
  const response =
    await axios.patch<GithubIntegrationResponse>(
      `/projects/${projectId}/github-integration`,
      data,
    );

  return response.data;
};