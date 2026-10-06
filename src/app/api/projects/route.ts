import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { assertSameOrigin, handler, json, limit, readJson, requireUser } from "@/server/http/api";
import { CreateProjectSchema } from "@/lib/settings";
import { createProject, listProjects } from "@/server/services/projects";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const user = await requireUser();
  return json({ projects: await listProjects(getDb(), user.id) });
});

export const POST = handler(async (req) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  await limit(`create:${user.id}`, 30, 3600);
  const env = getEnv();
  const body = await readJson(req, CreateProjectSchema, env.MAX_SCRIPT_CHARS * 4 + 10_000);
  const project = await createProject(getDb(), user.id, body, env.MAX_SCRIPT_CHARS);
  return json({ project: { id: project.id, title: project.title, status: project.status } }, { status: 201 });
});
