import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  cancelRun,
  getProjectRuns,
  getRunDetails,
  retryRun,
  triggerManualRun,
} from "@/api/runApi";
import type { TriggerManualRunInput } from "@/types/run";
import { getApiErrorMessage } from "@/lib/api-error";
import { toast } from "@/components/ui/toast";

export const runQueryKeys = {
  all: ["runs"] as const,
  project: (projectId: string) =>
    [...runQueryKeys.all, "project", projectId] as const,
  detail: (runId: string) =>
    [...runQueryKeys.all, "detail", runId] as const,
};

export const useProjectRuns = (projectId: string) =>
  useQuery({
    queryKey: runQueryKeys.project(projectId),
    queryFn: async () => {
      const response = await getProjectRuns(projectId);
      return response.data.runs;
    },
    enabled: projectId.length > 0,
    refetchInterval: 5000,
  });

export const useRunDetails = (runId: string) =>
  useQuery({
    queryKey: runQueryKeys.detail(runId),
    queryFn: async () => {
      const response = await getRunDetails(runId);
      return response.data;
    },
    enabled: runId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === "queued" || status === "running" ? 3000 : false;
    },
  });

export const useTriggerManualRun = (projectId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: TriggerManualRunInput) =>
      triggerManualRun(projectId, data),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: runQueryKeys.project(projectId),
      });
      toast.add({
        title: "Pipeline run triggered",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to trigger run",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useCancelRun = (projectId?: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runId: string) => cancelRun(runId),
    onSuccess: async (response, runId) => {
      await queryClient.invalidateQueries({
        queryKey: runQueryKeys.detail(runId),
      });
      if (projectId) {
        await queryClient.invalidateQueries({
          queryKey: runQueryKeys.project(projectId),
        });
      }
      toast.add({
        title: "Run cancelled",
        description: response.message,
        type: "info",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to cancel run",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};

export const useRetryRun = (projectId?: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runId: string) => retryRun(runId),
    onSuccess: async (response) => {
      if (projectId) {
        await queryClient.invalidateQueries({
          queryKey: runQueryKeys.project(projectId),
        });
      }
      toast.add({
        title: "Retry run queued",
        description: response.message,
        type: "success",
      });
    },
    onError: (error) => {
      toast.add({
        title: "Failed to retry run",
        description: getApiErrorMessage(error),
        type: "error",
      });
    },
  });
};