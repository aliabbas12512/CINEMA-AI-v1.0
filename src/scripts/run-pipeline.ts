import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/server/auth/password";
import { closeDb, getDb } from "@/server/db/client";
import { assets, projects, users } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { runPipeline } from "@/server/pipeline/orchestrator";
import { buildProviderSet, summarizeProviders } from "@/server/providers/registry";
import { getStorage } from "@/server/storage";
import { createProject } from "@/server/services/projects";
import { getProjectStatus } from "@/server/services/status";
import { randomBytes } from "node:crypto";

/**
 * Run the COMPLETE generation pipeline from the command line with the REAL
 * providers configured in .env (no queue, no browser):
 *
 *   npm run pipeline:run -- --script examples/sample-story.txt --duration 60 --email you@example.com
 *
 * The project is owned by --email (created if missing, with a random password
 * printed once) so the result also appears in the web UI.
 * Resume an existing project:  npm run pipeline:run -- --project <uuid>
 */
async function main() {
  const { values } = parseArgs({
    options: {
      script: { type: "string" },
      project: { type: "string" },
      email: { type: "string", default: "studio@example.com" },
      title: { type: "string" },
      duration: { type: "string", default: "60" },
      subtitles: { type: "string", default: "ur" },
    },
  });
  const env = getEnv();
  const db = getDb();

  let projectId = values.project;
  if (!projectId) {
    if (!values.script) throw new Error("Pass --script <file> (or --project <id> to resume).");
    const script = await readFile(path.resolve(values.script), "utf8");
    const email = values.email!.toLowerCase();
    let [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) {
      const password = randomBytes(12).toString("base64url");
      [user] = await db.insert(users).values({ email, passwordHash: await hashPassword(password) }).returning();
      console.log(`Created user ${email} with password: ${password}  (sign in to view the project in the UI)`);
    }
    const p = await createProject(
      db,
      user!.id,
      {
        title: values.title,
        script,
        settings: { targetDurationSec: Number(values.duration), subtitleLanguage: values.subtitles as "ur" | "en" | "off" },
      },
      env.MAX_SCRIPT_CHARS,
    );
    await db.update(projects).set({ status: "QUEUED", runCount: 1 }).where(eq(projects.id, p.id));
    projectId = p.id;
    console.log(`Project ${projectId} created.`);
  } else {
    await db.update(projects).set({ status: "QUEUED", control: "none" }).where(eq(projects.id, projectId));
  }

  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new Error(`Project ${projectId} not found`);
  const { providers, issues } = buildProviderSet({ narratorGender: p.settings.narratorVoice });
  console.log("\nProviders:");
  for (const r of summarizeProviders(providers, issues)) console.log(`  ${r.configured ? "✓" : "✕"} ${r.capability}: ${r.configured ? `${r.provider} (${r.model})` : r.message}`);

  const t0 = Date.now();
  const outcome = await runPipeline({ db, storage: getStorage(), providers, env }, projectId);
  const status = await getProjectStatus(db, projectId);
  console.log(`\nOutcome: ${outcome} in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const s of status.stages) console.log(`  ${s.label.padEnd(28)} ${s.status.padEnd(9)} ${s.completed}/${s.total}${s.failed ? ` (${s.failed} failed)` : ""}`);
  if (status.error) console.log(`\nError: ${status.error}`);
  if (status.finalAssetId) {
    const [a] = await db.select().from(assets).where(eq(assets.id, status.finalAssetId));
    const loc = env.STORAGE_DRIVER === "local" ? path.resolve(env.STORAGE_LOCAL_DIR, a!.storageKey) : a!.storageKey;
    console.log(`\nFinal video: ${loc}`);
  }
  await closeDb();
  process.exit(outcome === "COMPLETED" ? 0 : 1);
}

main().catch(async (err: unknown) => {
  console.error((err as Error).message);
  await closeDb();
  process.exit(1);
});
