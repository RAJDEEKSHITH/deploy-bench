import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
  createGithubIntegrationSchema,
  projectIdParamSchema,
  updateGithubIntegrationSchema,
} from "../validators/github-integration.validator.js";
import {
  validateBody,
  validateParams,
} from "../middlewares/validate.middleware.js";
import * as githubIntegrationsController from "../controllers/github-integration.controller.js";

const router = Router();

router.use(authenticate);

router.post("/:projectId/github-integration",
  validateParams(projectIdParamSchema),
  validateBody(createGithubIntegrationSchema),
  githubIntegrationsController.create
);

router.get("/:projectId/github-integration",
  validateParams(projectIdParamSchema),
  githubIntegrationsController.getOne
);

router.patch("/:projectId/github-integration",
  validateParams(projectIdParamSchema),
  validateBody(updateGithubIntegrationSchema),
  githubIntegrationsController.update
);

export default router;