import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
  validateBody,
  validateParams,
} from "../middlewares/validate.middleware.js";
import {
  projectRunsParamSchema,
  runIdParamSchema,
  triggerManualRunSchema,
} from "../validators/run.validator.js";
import * as runController from "../controllers/run.controller.js";

const router = Router();

router.use(authenticate);

// Project-scoped run routes: /api/v1/projects/:projectId/runs
router.get(
  "/projects/:projectId/runs",
  validateParams(projectRunsParamSchema),
  runController.listProjectRuns,
);

router.post(
  "/projects/:projectId/runs",
  validateParams(projectRunsParamSchema),
  validateBody(triggerManualRunSchema),
  runController.triggerManualRun,
);

// Direct run routes: /api/v1/runs/:runId
router.get(
  "/runs/:runId",
  validateParams(runIdParamSchema),
  runController.getRunDetails,
);

router.post(
  "/runs/:runId/cancel",
  validateParams(runIdParamSchema),
  runController.cancelRun,
);

router.post(
  "/runs/:runId/retry",
  validateParams(runIdParamSchema),
  runController.retryRun,
);

export default router;