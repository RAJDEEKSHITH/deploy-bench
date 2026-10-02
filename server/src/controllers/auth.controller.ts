
import type { Request, Response, NextFunction } from "express"
import { loginUserWithEmail, registerUserWithEmail } from "../services/auth/auth.service.js"
import { env } from "../config/env.js";
import { deleteAllSessionsByUserId, deleteSessionById, SESSION_TTL_IN_MS } from "../services/auth/session.service.js";

export const register = async (req : Request, res : Response, next : NextFunction) => {
    try {
        const user = await registerUserWithEmail(req.body);
        return res.status(201).json({
            success : true,
            message : "user registered successfully",
            data : {
                user
            }
    })
    } catch (error) {
        next(error)
    }
}

export const login = async(req: Request, res: Response, next: NextFunction) => {
    try {
        const {sessionId, user} = await loginUserWithEmail(req.body);
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_IN_MS,
      signed: true,
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        user,
      },
    })
 }
 catch (error) {
        next(error)
    }
}

export const getCurrentUser = async (req: Request, res: Response, _next: NextFunction) => {
    return res.status(200).json({
        success: true,
        message : "user information",
        data : req.user!
    })
}

export const logout = async (req: Request, res: Response, next: NextFunction) => {
    try {
     await deleteSessionById(req.sessionId!);
     res.clearCookie("sessionId");
    return res.status(200).json({
        success : true,
        message : "user logged out successfully",
        data : {}
    })
    } catch (error) {
      next(error)  
    }
}

export const logoutAll = async (req: Request, res:Response, next: NextFunction) => {
   try {
     await deleteAllSessionsByUserId(req.user!.id);
     res.clearCookie("sessionId");
    return res.status(200).json({
        success: true,
      message : "logged out from all devices",
      data : {}
    })
   } catch (error) {
    next(error)
   }
}