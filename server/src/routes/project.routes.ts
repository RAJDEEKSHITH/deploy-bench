import { Router } from "express";
import * as projectController from "../controllers/project.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
  createProjectSchema,
  projectIdParamSchema,
  updateProjectSchema,
} from "../validators/project/project.validator.js";
import {validateBody,validateParams} from "../middlewares/validate.middleware.js";

const router = Router();

router.use(authenticate);

router.post("/", validateBody(createProjectSchema), projectController.create);

router.get("/", projectController.getAll);

router.get("/:projectId",
  validateParams(projectIdParamSchema),
  projectController.getOne,
);

router.patch("/:projectId",
  validateParams(projectIdParamSchema),
  validateBody(updateProjectSchema),
  projectController.update,
);

router.delete("/:projectId",
  validateParams(projectIdParamSchema),
  projectController.remove,
);

export default router;
