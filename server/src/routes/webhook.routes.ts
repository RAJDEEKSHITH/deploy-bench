import express from "express";
import { validateParams} from "../middlewares/validate.middleware.js";
import { projectIdParamSchema} from "../validators/project.validator.js";
import * as webhookController from "../controllers/webhook.controller.js";

const router = express.Router();

router.post("/:projectId",
  validateParams(projectIdParamSchema),
  express.raw({
    type: "application/json",
    limit: "1mb",
  }),
  webhookController.receiveGithubWebhook,
);

export default router;