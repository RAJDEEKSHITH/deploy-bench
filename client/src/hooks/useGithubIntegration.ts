import axios from "axios";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  createGithubIntegration,
  getGithubIntegration,
  updateGithubIntegration,
} from "@/api/githubIntegrationApi";

import type {
  CreateGithubIntegrationInput,
  UpdateGithubIntegrationInput,
} from "@/types/githubIntegration";

import { getApiErrorMessage } from "@/lib/api-error";

import { toast } from "@/components/ui/toast";

export const githubIntegrationQueryKeys = {
  all: ["github-integration"] as const,

  project: (projectId: string) =>
    [...githubIntegrationQueryKeys.all, projectId] as const,
};

export const useGithubIntegration = (
  projectId: string,
) =>
  useQuery({
    queryKey:
      githubIntegrationQueryKeys.project(projectId),

    queryFn: async () => {
      try {
        const response =
          await getGithubIntegration(projectId);

        return response.data.integration;
      } catch (error) {
        if (
          axios.isAxiosError(error) &&
          error.response?.status === 404
        ) {
          return null;
        }

        throw error;
      }
    },

    enabled: projectId.length > 0,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

export const useCreateGithubIntegration = (
  projectId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      data: CreateGithubIntegrationInput,
    ) =>
      createGithubIntegration(
        projectId,
        data,
      ),

    onSuccess: async (response) => {
      queryClient.setQueryData(
        githubIntegrationQueryKeys.project(
          projectId,
        ),
        response.data.integration,
      );

      toast.add({
        title: "GitHub integration created",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "GitHub integration failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useUpdateGithubIntegration = (
  projectId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      data: UpdateGithubIntegrationInput,
    ) =>
      updateGithubIntegration(
        projectId,
        data,
      ),

    onSuccess: async (response) => {
      queryClient.setQueryData(
        githubIntegrationQueryKeys.project(
          projectId,
        ),
        response.data.integration,
      );

      toast.add({
        title: "GitHub integration updated",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "GitHub integration update failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};