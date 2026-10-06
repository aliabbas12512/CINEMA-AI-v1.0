import { notFound } from "next/navigation";
import { ProjectView } from "@/components/ProjectView";
import { requirePageUser } from "@/server/auth/page-auth";
import { getDb } from "@/server/db/client";
import { getOwnedProject, ServiceError } from "@/server/services/projects";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  try {
    await getOwnedProject(getDb(), user.id, id);
  } catch (err) {
    if (err instanceof ServiceError) notFound();
    throw err;
  }
  return <ProjectView projectId={id} />;
}
