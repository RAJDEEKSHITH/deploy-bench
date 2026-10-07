import axios from "./axios";

import type {
  CreateProjectInput,
  ProjectResponse,
  ProjectsResponse,
  UpdateProjectInput,
} from "../types/project";

export const getProjects =
  async (): Promise<ProjectsResponse> => {
    const response =
      await axios.get<ProjectsResponse>("/projects");

    return response.data;
  };

export const getProject = async (
  projectId: string,
): Promise<ProjectResponse> => {
  const response =
    await axios.get<ProjectResponse>(
      `/projects/${projectId}`,
    );

  return response.data;
};

export const createProject = async (
  data: CreateProjectInput,
): Promise<ProjectResponse> => {
  const response =
    await axios.post<ProjectResponse>(
      "/projects",
      data,
    );

  return response.data;
};

export const updateProject = async (
  projectId: string,
  data: UpdateProjectInput,
): Promise<ProjectResponse> => {
  const response =
    await axios.patch<ProjectResponse>(
      `/projects/${projectId}`,
      data,
    );

  return response.data;
};

export const deleteProject = async (
  projectId: string,
): Promise<ProjectResponse> => {
  const response =
    await axios.delete<ProjectResponse>(
      `/projects/${projectId}`,
    );

  return response.data;
};