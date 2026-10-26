import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createProjectEnvironment,
  deleteProjectEnvironment,
  getEnvironmentDeployments,
  getProjectEnvironments,
  rollbackEnvironmentDeployment,
  triggerEnvironmentDeployment,
  updateProjectEnvironment,
} from "@/api/deploymentApi";
import type {
  CreateDeploymentInput,
  CreateEnvironmentInput,
  UpdateEnvironmentInput,
} from "@/types/deployment";
import { getApiErrorMessage } from "@/lib/api-error";
import { toast } from "@/components/ui/toast";

export const deploymentQueryKeys = {
  environments: (projectId: string) =>
    ["environments", projectId] as const,
  history: (environmentId: string) =>
    ["deployments", environmentId] as const,
};

export const useProjectEnvironments = (projectId: string) =>
  useQuery({
    queryKey: deploymentQueryKeys.environments(projectId),
    queryFn: async () => {
      const response = await getProjectEnvironments(projectId);
      return response.data.environments;
    },
    enabled: projectId.length > 0,
  });

export const useCreateEnvironment = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateEnvironmentInput) =>
      createProjectEnvironment(projectId, data),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentQueryKeys.environments(projectId),
      });
      toast.add({
        title: "Environment created",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to create environment",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useUpdateEnvironment = (
  projectId: string,
  environmentId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateEnvironmentInput) =>
      updateProjectEnvironment(projectId, environmentId, data),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentQueryKeys.environments(projectId),
      });
      toast.add({
        title: "Environment updated",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to update environment",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useDeleteEnvironment = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (environmentId: string) =>
      deleteProjectEnvironment(projectId, environmentId),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: deploymentQueryKeys.environments(projectId),
      });
      toast.add({
        title: "Environment deleted",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to delete environment",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useEnvironmentDeployments = (environmentId: string) =>
  useQuery({
    queryKey: deploymentQueryKeys.history(environmentId),
    queryFn: async () => {
      const response = await getEnvironmentDeployments(environmentId);
      return response.data.deployments;
    },
    enabled: environmentId.length > 0,
    refetchInterval: 5000,
  });

export const useTriggerDeployment = (
  projectId: string,
  environmentId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateDeploymentInput) =>
      triggerEnvironmentDeployment(environmentId, data),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: deploymentQueryKeys.history(environmentId),
        }),
        queryClient.invalidateQueries({
          queryKey: deploymentQueryKeys.environments(projectId),
        }),
      ]);
      toast.add({
        title: "Deployment queued",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to trigger deployment",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useRollbackDeployment = (
  projectId: string,
  environmentId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (targetDeploymentId?: string) =>
      rollbackEnvironmentDeployment(environmentId, targetDeploymentId),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: deploymentQueryKeys.history(environmentId),
        }),
        queryClient.invalidateQueries({
          queryKey: deploymentQueryKeys.environments(projectId),
        }),
      ]);
      toast.add({
        title: "Rollback queued",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Rollback failed",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};