import axios from "./axios";
import type {
  RunDetailsResponse,
  RunResponse,
  RunsResponse,
  TriggerManualRunInput,
} from "@/types/run";

export const getProjectRuns = async (
  projectId: string,
): Promise<RunsResponse> => {
  const response = await axios.get<RunsResponse>(
    `/projects/${projectId}/runs`,
  );
  return response.data;
};

export const triggerManualRun = async (
  projectId: string,
  data: TriggerManualRunInput,
): Promise<RunResponse> => {
  const response = await axios.post<RunResponse>(
    `/projects/${projectId}/runs`,
    data,
  );
  return response.data;
};

export const getRunDetails = async (
  runId: string,
): Promise<RunDetailsResponse> => {
  const response = await axios.get<RunDetailsResponse>(`/runs/${runId}`);
  return response.data;
};

export const cancelRun = async (runId: string): Promise<RunResponse> => {
  const response = await axios.post<RunResponse>(`/runs/${runId}/cancel`);
  return response.data;
};

export const retryRun = async (runId: string): Promise<RunResponse> => {
  const response = await axios.post<RunResponse>(`/runs/${runId}/retry`);
  return response.data;
};