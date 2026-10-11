import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { getEnv } from "@/server/env";

export const SESSION_COOKIE = "afs_session";
export const SESSION_TTL_SEC = 30 * 24 * 3600;

export type SessionUser = { id: string; email: string; name: string | null };

/** DB stores only an HMAC of the token (keyed by SESSION_SECRET), never the token itself. */
export function tokenHash(token: string): string {
  return createHmac("sha256", getEnv().SESSION_SECRET).update(token).digest("hex");
}

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
  await db.insert(sessions).values({ tokenHash: tokenHash(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
