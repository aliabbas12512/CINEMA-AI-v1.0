import { cookies } from "next/headers";
import { destroySession, SESSION_COOKIE } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { assertSameOrigin, handler, json } from "@/server/http/api";

export const runtime = "nodejs";

export const POST = handler(async (req) => {
  await assertSameOrigin(req);
  const jar = await cookies();
  await destroySession(getDb(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return json({ ok: true });
});
