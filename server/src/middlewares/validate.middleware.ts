import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { z } from "zod";

export const validateBody = (schema: ZodType) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: z.flattenError(result.error).fieldErrors,
      });
    }

    req.body = result.data;

    next();
  };
};

export const validateParams = (schema: z.ZodType) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid route parameters",
        errors: z.flattenError(result.error).fieldErrors,
      });
    }
    next();
  };
};