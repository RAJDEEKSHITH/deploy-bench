import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  createProject,
  deleteProject,
  getProject,
  getProjects,
  updateProject,
} from "@/api/projectApi";

import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "@/types/project";

import { getApiErrorMessage } from "../lib/api-error";
import { toast } from "@/components/ui/toast";

export const projectQueryKeys = {
  all: ["projects"] as const,

  list: () =>
    [...projectQueryKeys.all, "list"] as const,

  detail: (projectId: string) =>
    [...projectQueryKeys.all, "detail", projectId] as const,
};

export const useProjects = () =>
  useQuery({
    queryKey: projectQueryKeys.list(),
    queryFn: async () => {
      const response = await getProjects();

      return response.data.projects;
    },
  });

export const useProject = (projectId: string) =>
  useQuery({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: async () => {
      const response = await getProject(projectId);

      return response.data.project;
    },
    enabled: projectId.length > 0,
  });

export const useCreateProject = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateProjectInput) =>
      createProject(data),

    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.list(),
      });

      toast.add({
        title: "Project created",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Project creation failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useUpdateProject = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateProjectInput) =>
      updateProject(projectId, data),

    onSuccess: async (response) => {
      queryClient.setQueryData(
        projectQueryKeys.detail(projectId),
        response.data.project,
      );

      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.list(),
      });

      toast.add({
        title: "Project updated",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Project update failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useDeleteProject = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) =>
      deleteProject(projectId),

    onSuccess: async (_response, projectId) => {
      queryClient.removeQueries({
        queryKey: projectQueryKeys.detail(projectId),
      });

      await queryClient.invalidateQueries({
        queryKey: projectQueryKeys.list(),
      });

      toast.add({
        title: "Project deleted",
        description: "The project was deleted successfully.",
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Project deletion failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};