import type { NextFunction, Request, Response } from "express";
import {
  createGithubIntegration,
  getGithubIntegration,
  updateGithubIntegration,
} from "../services/github/github-integration.service.js";
import type { GithubIntegrationProjectParams as ProjectParams } from "../validators/github/github-integration.validator.js";

export const create = async (
  req: Request<ProjectParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const integration = await createGithubIntegration(
      req.params.projectId,
      req.user!.id,
      req.body,
    );

    return res.status(201).json({
      success: true,
      message: "GitHub integration created successfully",
      data: {
        integration,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getOne = async (
  req: Request<ProjectParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const integration = await getGithubIntegration(
      req.params.projectId,
      req.user!.id,
    );

    return res.status(200).json({
      success: true,
      message: "GitHub integration fetched successfully",
      data: {
        integration,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const update = async (
  req: Request<ProjectParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const integration = await updateGithubIntegration(
      req.params.projectId,
      req.user!.id,
      req.body,
    );

    return res.status(200).json({
      success: true,
      message: "GitHub integration updated successfully",
      data: {
        integration,
      },
    });
  } catch (error) {
    next(error);
  }
};
