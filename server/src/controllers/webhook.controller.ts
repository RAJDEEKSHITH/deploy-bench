import type { NextFunction,Request,Response} from "express";

import { ingestGithubWebhook} from "../services/github/github-webhook.service.js";

import type { ProjectIdParam } from "../validators/project/project.validator.js";

export const receiveGithubWebhook = async (
    req: Request<ProjectIdParam,any,Buffer>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await ingestGithubWebhook({
          projectId: req.params.projectId,
          githubDeliveryId: req.get("X-GitHub-Delivery"),
          eventName: req.get("X-GitHub-Event"),
          signature: req.get("X-Hub-Signature-256"),
          rawBody: req.body,
        });

      if(result.status === "ignored") {
        return res.status(202).json({
          success: true,
          message: "webhook event ignored",
          data: {
            reason: result.reason,
          },
        });
      }

      return res.status(202).json({
        success: true,
        message: result.duplicate
          ? "webhook already accepted"
          : "webhook accepted",
        data: {
          webhookDeliveryId: result.webhookDeliveryId,
        },
      });
    } catch (error) {
      next(error);
    }
  };