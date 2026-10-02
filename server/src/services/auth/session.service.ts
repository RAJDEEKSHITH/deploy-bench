import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";

export const SESSION_TTL_IN_MS = 10000 * 60 * 60 * 24 * 7; // 7 days
const MAX_SESSIONS = 2;

export const createSession = async (userId: string) => {
  await enforceSessionLimit(userId);
  const expiresAt = new Date(Date.now() + SESSION_TTL_IN_MS);
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      expiresAt,
    })
    .returning({
      id: sessions.id,
    });
  if (!session) {
    throw new AppError("Failed to create session", 500);
  }
  return session.id;
};

export const enforceSessionLimit = async (userId: string) => {
  const activeSessions = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(asc(sessions.createdAt));

  if (activeSessions.length >= MAX_SESSIONS) {
    const excessCount = activeSessions.length - MAX_SESSIONS + 1;
    const sessionIdsToDelete = activeSessions
      .slice(0, excessCount)
      .map((s) => s.id);
    if (sessionIdsToDelete.length > 0) {
      await db.delete(sessions).where(inArray(sessions.id, sessionIdsToDelete));
    }
  }
};

export const getSession = async (sessionId: string) => {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())));
  return session;
};

export const deleteSessionById = async (sessionId: string) => {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
};

export const deleteAllSessionsByUserId = async (userId: string) => {
  await db.delete(sessions).where(eq(sessions.userId,userId));
};
