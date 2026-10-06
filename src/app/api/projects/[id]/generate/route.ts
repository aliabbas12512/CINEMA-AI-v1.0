import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { assertSameOrigin, handler, json, limit, requireUser } from "@/server/http/api";
import { enqueuePipeline } from "@/server/pipeline/queue";
import { startGeneration } from "@/server/services/projects";

export const runtime = "nodejs";

/** Start or resume (retries only failed/unfinished units). */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  await limit(`generate:${user.id}`, getEnv().RATE_LIMIT_GENERATIONS_PER_HOUR, 3600);
  const { id } = await params;
  const { run } = await startGeneration(getDb(), user.id, id, enqueuePipeline);
  return json({ ok: true, run }, { status: 202 });
});
