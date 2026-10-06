import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "@/server/auth/session";
import { rateLimit } from "@/server/auth/rate-limit";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";
import { getRedis } from "@/server/pipeline/queue";
import { ServiceError } from "@/server/services/projects";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

/** Wrap a route handler: consistent JSON errors, no stack traces leaked. */
export function handler<A extends unknown[]>(fn: (req: Request, ...args: A) => Promise<Response>) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      return await fn(req, ...args);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status, headers: err.headers });
      if (err instanceof ServiceError) return json({ error: err.message }, { status: err.status });
      if (err instanceof z.ZodError) return json({ error: err.issues.map((i) => i.message).join("; ") }, { status: 400 });
      logger.error({ err: (err as Error).message, path: new URL(req.url).pathname }, "unhandled API error");
      return json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(getDb(), token);
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Authentication required");
  return u;
}

/**
 * CSRF defence for cookie-authenticated state changes: the Origin (or
 * Referer) must match this app. SameSite=Lax cookies add a second layer.
 */
export async function assertSameOrigin(req: Request): Promise<void> {
  const h = await headers();
  const origin = h.get("origin") ?? (h.get("referer") ? new URL(h.get("referer")!).origin : null);
  const allowed = new Set([new URL(getEnv().APP_URL).origin, new URL(req.url).origin]);
  if (!origin || !allowed.has(origin)) throw new HttpError(403, "Cross-origin request rejected");
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = 1_000_000): Promise<z.infer<S>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "Request body too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  let body: unknown;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  return schema.parse(body);
}

export async function limit(key: string, max: number, windowSec: number): Promise<void> {
  let r;
  try {
    r = await rateLimit(getRedis(), key, max, windowSec);
  } catch {
    throw new HttpError(503, "Rate limiter unavailable; try again shortly");
  }
  if (!r.allowed) throw new HttpError(429, "Too many requests. Please slow down.", { "Retry-After": String(r.retryAfterSec) });
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown").slice(0, 64);
}
