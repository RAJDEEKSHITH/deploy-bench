import { useQuery } from "@tanstack/react-query";
import { getRunJob, getRunJobs } from "@/api/jobApi";

export const jobQueryKeys = {
  all: ["jobs"] as const,
  run: (runId: string) => [...jobQueryKeys.all, "run", runId] as const,
  detail: (runId: string, jobId: string) =>
    [...jobQueryKeys.all, "detail", runId, jobId] as const,
};

export const useRunJobs = (runId: string) =>
  useQuery({
    queryKey: jobQueryKeys.run(runId),
    queryFn: async () => {
      const response = await getRunJobs(runId);
      return response.data;
    },
    enabled: runId.length > 0,
  });

export const useRunJob = (runId: string, jobId: string) =>
  useQuery({
    queryKey: jobQueryKeys.detail(runId, jobId),
    queryFn: async () => {
      const response = await getRunJob(runId, jobId);
      return response.data;
    },
    enabled: runId.length > 0 && jobId.length > 0,
  });