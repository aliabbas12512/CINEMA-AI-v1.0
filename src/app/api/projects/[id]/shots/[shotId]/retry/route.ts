import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { assertSameOrigin, handler, json, limit, readJson, requireUser } from "@/server/http/api";
import { enqueuePipeline } from "@/server/pipeline/queue";
import { retryShot } from "@/server/services/projects";

export const runtime = "nodejs";

const Body = z.object({ regenerateKeyframe: z.boolean().default(false) });

export const POST = handler(async (req, { params }: { params: Promise<{ id: string; shotId: string }> }) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  await limit(`generate:${user.id}`, getEnv().RATE_LIMIT_GENERATIONS_PER_HOUR, 3600);
  const { id, shotId } = await params;
  const body = await readJson(req, Body, 1000);
  const { run } = await retryShot(getDb(), user.id, id, shotId, body, enqueuePipeline);
  return json({ ok: true, run }, { status: 202 });
});
