import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { validateParams } from "../middlewares/validate.middleware.js";
import {
  runJobIdParamSchema,
  runJobsParamSchema,
} from "../validators/job.validator.js";
import * as jobController from "../controllers/job.controller.js";

const router = Router();

router.use(authenticate);

router.get(
  "/runs/:runId/jobs",
  validateParams(runJobsParamSchema),
  jobController.listRunJobs,
);

router.get(
  "/runs/:runId/jobs/:jobId",
  validateParams(runJobIdParamSchema),
  jobController.getRunJob,
);

router.get(
  "/runs/:runId/jobs/:jobId/attempts",
  validateParams(runJobIdParamSchema),
  jobController.listJobAttempts,
);

export default router;