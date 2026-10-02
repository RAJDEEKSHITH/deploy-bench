import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { AppError } from "../utils/app.error.js";
import { getSession } from "../services/auth/session.service.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.signedCookies.sessionId;
    
    if (!sessionId) {
      throw new AppError("User not authenticated", 401);
    }

    const session = await getSession(sessionId);
    if (!session) {
      res.clearCookie("sessionId");
      throw new AppError("Session expired", 401);
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId));

    if (!user) {
      throw new AppError("User not found", 401);
    }
    const { passwordHash, ...publicUser } = user;

    req.user = publicUser;
    req.sessionId = session.id;

    next();
  } catch (error) {
    next(error);
  }
};