import { getDb } from "@/server/db/client";
import { handler, json, requireUser } from "@/server/http/api";
import { getLogs } from "@/server/services/detail";
import { getOwnedProject } from "@/server/services/projects";

export const runtime = "nodejs";

export const GET = handler(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await getOwnedProject(getDb(), user.id, id);
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0") || 0;
  return json({ logs: await getLogs(getDb(), id, after) });
});
