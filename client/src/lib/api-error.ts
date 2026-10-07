import axios from "axios";

import type { ApiErrorResponse } from "@/types/auth";

export const isUnauthorizedError = (
  error: unknown,
): boolean => {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 401
  );
};

export const getApiErrorMessage = (
  error: unknown,
): string => {
  if (axios.isAxiosError<ApiErrorResponse>(error)) {
    return (
      error.response?.data?.message ??
      "Something went wrong. Please try again."
    );
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
};