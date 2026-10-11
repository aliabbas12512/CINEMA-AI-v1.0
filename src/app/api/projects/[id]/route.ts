import { getDb } from "@/server/db/client";
import { assertSameOrigin, handler, json, requireUser } from "@/server/http/api";
import { getStorage } from "@/server/storage";
import { getProjectDetail } from "@/server/services/detail";
import { deleteProject, getOwnedProject } from "@/server/services/projects";
import { getProjectStatus } from "@/server/services/status";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  const project = await getOwnedProject(getDb(), user.id, id);
  const [status, detail] = await Promise.all([getProjectStatus(getDb(), project.id), getProjectDetail(getDb(), project.id)]);
  return json({ project: { id: project.id, title: project.title, settings: project.settings, createdAt: project.createdAt }, status, detail });
});

export const DELETE = handler(async (req, { params }: Ctx) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  const { id } = await params;
  await deleteProject(getDb(), getStorage(), user.id, id);
  return json({ ok: true });
});
