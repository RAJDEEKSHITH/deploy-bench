import { Router } from "express";
import {
  getJobLogsMetadataController,
  streamJobLogsController,
} from "../controllers/log.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";

const logRouter = Router();

logRouter.get(
  "/runs/:runId/jobs/:jobId/logs",
  authenticate,
  getJobLogsMetadataController,
);

logRouter.get(
  "/runs/:runId/jobs/:jobId/logs/stream",
  authenticate,
  streamJobLogsController,
);

export default logRouter;