import { z } from "zod";
import { getDb } from "@/server/db/client";
import { assertSameOrigin, handler, json, readJson, requireUser } from "@/server/http/api";
import { requestControl } from "@/server/services/projects";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["pause", "cancel"]) });

/** Pause/cancel are requests; the worker confirms them at the next safe checkpoint. */
export const POST = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await params;
  const { action } = await readJson(req, Body, 1000);
  const status = await requestControl(getDb(), user.id, id, action);
  return json({ ok: true, requested: action, status }, { status: 202 });
});
