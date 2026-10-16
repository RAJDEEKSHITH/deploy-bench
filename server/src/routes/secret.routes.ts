import { Router } from "express";
import { validateBody,validateParams } from "../middlewares/validate.middleware.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import * as secretController from "../controllers/secret.controllerr.js";

import {
  createSecretSchema,
  environmentSecretIdParamsSchema,
  environmentSecretParamsSchema,
  projectSecretIdParamsSchema,
  projectSecretParamsSchema,
  updateSecretSchema,
} from "../validators/secret.validator.js";

const router = Router();

router.use(authenticate);

// project secrets
router.post("/:projectId/secrets",
  validateParams(projectSecretParamsSchema),
  validateBody(createSecretSchema),
  secretController.createProjectSecret,
);

router.get("/:projectId/secrets",
  validateParams(projectSecretParamsSchema),
  secretController.listProjectSecrets,
);

router.get("/:projectId/secrets/:secretId",
  validateParams(projectSecretIdParamsSchema),
  secretController.getProjectSecret,
);

router.patch("/:projectId/secrets/:secretId",
  validateParams(projectSecretIdParamsSchema),
  validateBody(updateSecretSchema),
  secretController.updateProjectSecret,
);

router.delete("/:projectId/secrets/:secretId",
  validateParams(projectSecretIdParamsSchema),
  secretController.deleteProjectSecret,
);

// environement secrets
router.post("/:projectId/environments/:environmentId/secrets",
  validateParams(environmentSecretParamsSchema),
  validateBody(createSecretSchema),
  secretController.createEnvironmentSecret,
);

router.get("/:projectId/environments/:environmentId/secrets",
  validateParams(environmentSecretParamsSchema),
  secretController.listEnvironmentSecrets,
);

router.get("/:projectId/environments/:environmentId/secrets/:secretId",
  validateParams(environmentSecretIdParamsSchema),
  secretController.getEnvironmentSecret
);

router.patch("/:projectId/environments/:environmentId/secrets/:secretId",
  validateParams(environmentSecretIdParamsSchema),
  validateBody(updateSecretSchema),
  secretController.updateEnvironmentSecret,
);

router.delete("/:projectId/environments/:environmentId/secrets/:secretId",
  validateParams(environmentSecretIdParamsSchema),
  secretController.deleteEnvironmentSecret,
);

export default router;