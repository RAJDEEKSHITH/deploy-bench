import axios, { BASE_URL } from "./axios";
import type { JobDetailsResponse, RunJobsResponse } from "@/types/job";

export const getRunJobs = async (runId: string): Promise<RunJobsResponse> => {
  const response = await axios.get<RunJobsResponse>(`/runs/${runId}/jobs`);
  return response.data;
};

export const getRunJob = async (
  runId: string,
  jobId: string,
): Promise<JobDetailsResponse> => {
  const response = await axios.get<JobDetailsResponse>(
    `/runs/${runId}/jobs/${jobId}`,
  );
  return response.data;
};

export const getJobLogStreamUrl = (runId: string, jobId: string): string => {
  return `${BASE_URL.replace(/\/$/, "")}/runs/${runId}/jobs/${jobId}/logs/stream`;
};