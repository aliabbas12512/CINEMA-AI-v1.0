import { cookies } from "next/headers";
import { createSession, SESSION_COOKIE, SESSION_TTL_SEC } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { assertSameOrigin, clientIp, handler, HttpError, json, limit, readJson } from "@/server/http/api";
import { signup, SignupSchema } from "@/server/services/auth";

export const runtime = "nodejs";

export const POST = handler(async (req) => {
  await assertSameOrigin(req);
  const env = getEnv();
  if (env.ALLOW_SIGNUP !== "true") throw new HttpError(403, "Sign-up is disabled on this server.");
  await limit(`auth:${await clientIp()}`, env.RATE_LIMIT_AUTH_PER_15MIN, 900);
  const input = await readJson(req, SignupSchema, 10_000);
  const user = await signup(getDb(), input);
  const { token, expiresAt } = await createSession(getDb(), user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_TTL_SEC,
  });
  return json({ user }, { status: 201 });
});
