import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
  validateBody,
  validateParams,
} from "../middlewares/validate.middleware.js";
import {
  createDeploymentSchema,
  createEnvironmentSchema,
  deploymentIdParamSchema,
  environmentIdParamSchema,
  projectEnvironmentIdParamsSchema,
  projectEnvironmentParamsSchema,
  rollbackDeploymentSchema,
  updateEnvironmentSchema,
} from "../validators/deployment.validator.js";
import * as deploymentController from "../controllers/deployment.controller.js";

const router = Router();

router.use(authenticate);

// Project environments: /api/v1/projects/:projectId/environments
router.get(
  "/projects/:projectId/environments",
  validateParams(projectEnvironmentParamsSchema),
  deploymentController.listProjectEnvironments,
);

router.post(
  "/projects/:projectId/environments",
  validateParams(projectEnvironmentParamsSchema),
  validateBody(createEnvironmentSchema),
  deploymentController.createProjectEnvironment,
);

router.get(
  "/projects/:projectId/environments/:environmentId",
  validateParams(projectEnvironmentIdParamsSchema),
  deploymentController.getProjectEnvironment,
);

router.patch(
  "/projects/:projectId/environments/:environmentId",
  validateParams(projectEnvironmentIdParamsSchema),
  validateBody(updateEnvironmentSchema),
  deploymentController.updateProjectEnvironment,
);

router.delete(
  "/projects/:projectId/environments/:environmentId",
  validateParams(projectEnvironmentIdParamsSchema),
  deploymentController.deleteProjectEnvironment,
);

// Environment deployments & rollbacks: /api/v1/environments/:environmentId/...
router.get(
  "/environments/:environmentId/eligibility",
  validateParams(environmentIdParamSchema),
  deploymentController.checkEnvironmentDeploymentEligibility,
);

router.get(
  "/environments/:environmentId/deployments",
  validateParams(environmentIdParamSchema),
  deploymentController.listEnvironmentDeployments,
);

router.post(
  "/environments/:environmentId/deployments",
  validateParams(environmentIdParamSchema),
  validateBody(createDeploymentSchema),
  deploymentController.triggerDeployment,
);

router.post(
  "/environments/:environmentId/rollback",
  validateParams(environmentIdParamSchema),
  validateBody(rollbackDeploymentSchema),
  deploymentController.rollbackEnvironmentDeployment,
);

// Single deployment: /api/v1/deployments/:deploymentId
router.get(
  "/deployments/:deploymentId",
  validateParams(deploymentIdParamSchema),
  deploymentController.getDeploymentById,
);

export default router;