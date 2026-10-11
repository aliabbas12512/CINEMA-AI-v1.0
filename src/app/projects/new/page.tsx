import { NewProjectForm } from "@/components/NewProjectForm";
import { requirePageUser } from "@/server/auth/page-auth";
import { getEnv } from "@/server/env";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  await requirePageUser();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gold-300">Create New Video</h1>
        <p className="mt-1 text-white/50">Paste one story. Choose settings. Generate.</p>
      </div>
      <NewProjectForm maxChars={getEnv().MAX_SCRIPT_CHARS} />
    </div>
  );
}
