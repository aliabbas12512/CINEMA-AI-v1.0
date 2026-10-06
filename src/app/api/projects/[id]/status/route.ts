import { getDb } from "@/server/db/client";
import { handler, json, requireUser } from "@/server/http/api";
import { getOwnedProject } from "@/server/services/projects";
import { getProjectStatus } from "@/server/services/status";

export const runtime = "nodejs";

export const GET = handler(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await getOwnedProject(getDb(), user.id, id);
  return json(await getProjectStatus(getDb(), id));
});
