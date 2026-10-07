import type { Request, Response } from "express";

import { AppError } from "../utils/app.error.js";
import {
  streamJobLogs,
} from "../services/logs/log-sse.service.js";

export const streamJobLogsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { runId, jobId } = req.params;

  /**
   * With strict TypeScript/Express typings, route params
   * cannot blindly be assumed to be strings.
   */
  if (
    typeof runId !== "string" ||
    typeof jobId !== "string"
  ) {
    throw new AppError(
      "Invalid run or job ID",
      400,
    );
  }

  /**
   * Authentication middleware must populate req.user
   * before this controller is reached.
   */
  if (!req.user) {
    throw new AppError(
      "Authentication required",
      401,
    );
  }

  await streamJobLogs({
    response: res,
    runId,
    jobId,
  });
};