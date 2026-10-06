import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { json } from "@/server/http/api";
import { getRedis } from "@/server/pipeline/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, boolean> = {};
  try {
    await getDb().execute(sql`select 1`);
    checks.database = true;
  } catch {
    checks.database = false;
  }
  try {
    checks.redis = (await getRedis().ping()) === "PONG";
  } catch {
    checks.redis = false;
  }
  const ok = Object.values(checks).every(Boolean);
  return json({ ok, checks }, { status: ok ? 200 : 503 });
}
