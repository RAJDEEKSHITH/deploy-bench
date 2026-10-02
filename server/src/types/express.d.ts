import { users } from "../db/schema.js";

type FullUser = typeof users.$inferSelect;
export type PublicUser = Omit<FullUser, "passwordHash">;

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string; 
    }
  }
}
