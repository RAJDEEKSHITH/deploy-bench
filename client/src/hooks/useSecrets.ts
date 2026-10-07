import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createEnvironmentSecret,
  createProjectSecret,
  deleteEnvironmentSecret,
  deleteProjectSecret,
  getEnvironmentSecret,
  getEnvironmentSecrets,
  getProjectSecret,
  getProjectSecrets,
  updateEnvironmentSecret,
  updateProjectSecret,
} from "@/api/secretApi";

import type {
  CreateSecretInput,
  UpdateSecretInput,
} from "@/types/secret";

import { getApiErrorMessage } from "@/lib/api-error";

import { toast } from "@/components/ui/toast";

export const secretQueryKeys = {
  all: ["secrets"] as const,

  project: (projectId: string) =>
    [...secretQueryKeys.all, "project", projectId] as const,

  projectDetail: (
    projectId: string,
    secretId: string,
  ) =>
    [
      ...secretQueryKeys.project(projectId),
      "detail",
      secretId,
    ] as const,

  environment: (
    projectId: string,
    environmentId: string,
  ) =>
    [
      ...secretQueryKeys.all,
      "environment",
      projectId,
      environmentId,
    ] as const,

  environmentDetail: (
    projectId: string,
    environmentId: string,
    secretId: string,
  ) =>
    [
      ...secretQueryKeys.environment(
        projectId,
        environmentId,
      ),
      "detail",
      secretId,
    ] as const,
};

/* -------------------------------------------------------------------------- */
/* Project secrets                                                            */
/* -------------------------------------------------------------------------- */

export const useProjectSecrets = (
  projectId: string,
) =>
  useQuery({
    queryKey: secretQueryKeys.project(projectId),
    queryFn: async () => {
      const response =
        await getProjectSecrets(projectId);

      return response.data.secrets;
    },
    enabled: projectId.length > 0,
  });

export const useProjectSecret = (
  projectId: string,
  secretId: string,
) =>
  useQuery({
    queryKey: secretQueryKeys.projectDetail(
      projectId,
      secretId,
    ),
    queryFn: async () => {
      const response =
        await getProjectSecret(
          projectId,
          secretId,
        );

      return response.data.secret;
    },
    enabled:
      projectId.length > 0 &&
      secretId.length > 0,
  });

export const useCreateProjectSecret = (
  projectId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateSecretInput) =>
      createProjectSecret(
        projectId,
        data,
      ),

    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.project(projectId),
      });

      toast.add({
        title: "Secret created",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to create secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useUpdateProjectSecret = (
  projectId: string,
  secretId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateSecretInput) =>
      updateProjectSecret(
        projectId,
        secretId,
        data,
      ),

    onSuccess: async (response) => {
      queryClient.setQueryData(
        secretQueryKeys.projectDetail(
          projectId,
          secretId,
        ),
        response.data.secret,
      );

      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.project(projectId),
      });

      toast.add({
        title: "Secret updated",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to update secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useDeleteProjectSecret = (
  projectId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (secretId: string) =>
      deleteProjectSecret(
        projectId,
        secretId,
      ),

    onSuccess: async (_response, secretId) => {
      queryClient.removeQueries({
        queryKey:
          secretQueryKeys.projectDetail(
            projectId,
            secretId,
          ),
      });

      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.project(projectId),
      });

      toast.add({
        title: "Secret deleted",
        description:
          "The secret was deleted successfully.",
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to delete secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

/* -------------------------------------------------------------------------- */
/* Environment secrets                                                        */
/* -------------------------------------------------------------------------- */

export const useEnvironmentSecrets = (
  projectId: string,
  environmentId: string,
) =>
  useQuery({
    queryKey:
      secretQueryKeys.environment(
        projectId,
        environmentId,
      ),
    queryFn: async () => {
      const response =
        await getEnvironmentSecrets(
          projectId,
          environmentId,
        );

      return response.data.secrets;
    },
    enabled:
      projectId.length > 0 &&
      environmentId.length > 0,
  });

export const useEnvironmentSecret = (
  projectId: string,
  environmentId: string,
  secretId: string,
) =>
  useQuery({
    queryKey:
      secretQueryKeys.environmentDetail(
        projectId,
        environmentId,
        secretId,
      ),
    queryFn: async () => {
      const response =
        await getEnvironmentSecret(
          projectId,
          environmentId,
          secretId,
        );

      return response.data.secret;
    },
    enabled:
      projectId.length > 0 &&
      environmentId.length > 0 &&
      secretId.length > 0,
  });

export const useCreateEnvironmentSecret = (
  projectId: string,
  environmentId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateSecretInput) =>
      createEnvironmentSecret(
        projectId,
        environmentId,
        data,
      ),

    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.environment(
            projectId,
            environmentId,
          ),
      });

      toast.add({
        title: "Secret created",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to create secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useUpdateEnvironmentSecret = (
  projectId: string,
  environmentId: string,
  secretId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdateSecretInput) =>
      updateEnvironmentSecret(
        projectId,
        environmentId,
        secretId,
        data,
      ),

    onSuccess: async (response) => {
      queryClient.setQueryData(
        secretQueryKeys.environmentDetail(
          projectId,
          environmentId,
          secretId,
        ),
        response.data.secret,
      );

      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.environment(
            projectId,
            environmentId,
          ),
      });

      toast.add({
        title: "Secret updated",
        description: response.message,
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to update secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useDeleteEnvironmentSecret = (
  projectId: string,
  environmentId: string,
) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (secretId: string) =>
      deleteEnvironmentSecret(
        projectId,
        environmentId,
        secretId,
      ),

    onSuccess: async (_response, secretId) => {
      queryClient.removeQueries({
        queryKey:
          secretQueryKeys.environmentDetail(
            projectId,
            environmentId,
            secretId,
          ),
      });

      await queryClient.invalidateQueries({
        queryKey:
          secretQueryKeys.environment(
            projectId,
            environmentId,
          ),
      });

      toast.add({
        title: "Secret deleted",
        description:
          "The secret was deleted successfully.",
        type: "success",
      });
    },

    onError: (error) => {
      toast.add({
        title: "Failed to delete secret",
        description:
          getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};