import type {
  Request,
  Response,
  NextFunction,
} from "express";

import {
  createProject,
  deleteProject,
  getProjectById,
  getProjects,
  updateProject,
} from "../services/projects/project.service.js";

export const create = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await createProject(
      req.body,
      req.user!.id,
    );

    return res.status(201).json({
      success: true,
      message: "Project created successfully",
      data: {
        project,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getAll = async ( req: Request, res: Response, next: NextFunction) => {
  try {
    const projects = await getProjects(req.user!.id);

    return res.status(200).json({
      success: true,
      message: "Projects fetched successfully",
      data: {
        projects,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getOne = async (req: Request<{projectId : string}>, res: Response,
next: NextFunction ) => {
  try {
    const project = await getProjectById(
      req.params.projectId,
      req.user!.id,
    );

    return res.status(200).json({
      success: true,
      message: "Project fetched successfully",
      data: {
        project,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const update = async (
  req: Request<{projectId : string}>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const project = await updateProject(
      req.params.projectId,
      req.user!.id,
      req.body,
    );

    return res.status(200).json({
      success: true,
      message: "Project updated successfully",
      data: {
        project,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const remove = async (req: Request<{projectId : string}>, res: Response,
  next: NextFunction ) => {
  try {
    const project = await deleteProject(req.params.projectId,req.user!.id);

    return res.status(200).json({
      success: true,
      message: "Project deleted successfully",
      data: {
        project,
      },
    });
  } catch (error) {
    next(error);
  }
};