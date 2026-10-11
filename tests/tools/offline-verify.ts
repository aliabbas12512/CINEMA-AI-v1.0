/**
 * VERIFICATION TOOL (not part of the app): runs the complete pipeline against the
 * development database/storage with REAL video (ffmpeg_motion), REAL FFmpeg
 * assembly/mix/subtitles/QC and the REAL queue-free orchestrator, while the three
 * credentialed services (Anthropic LLM, Azure voice, Cloudflare images) are
 * replaced by the test doubles from tests/mocks because no keys are configured.
 *
 *   npx tsx --env-file-if-exists=.env tests/tools/offline-verify.ts --email you@example.com
 *
 * The project title is prefixed with "[VERIFICATION - test doubles]" so it can
 * never be mistaken for a real generation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/server/auth/password";
import { closeDb, getDb } from "@/server/db/client";
import { assets, projects, users } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { runPipeline } from "@/server/pipeline/orchestrator";
import { FfmpegMotionVideoProvider } from "@/server/providers/adapters/ffmpeg-motion";
import { getStorage } from "@/server/storage";
import { createProject } from "@/server/services/projects";
import { getProjectStatus } from "@/server/services/status";
import { mockProviderSet } from "../mocks/providers";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string", default: "verify@example.com" }, password: { type: "string" } } });
  const env = getEnv();
  const db = getDb();
  const email = values.email!.toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    [user] = await db.insert(users).values({ email, passwordHash: await hashPassword(values.password ?? "verify-password-123") }).returning();
  }
  const script = await readFile(path.resolve("examples/sample-story.txt"), "utf8");
  const p = await createProject(
    db,
    user!.id,
    { title: "[VERIFICATION - test doubles for LLM/voice/images] Shehzada Zain", script, settings: { targetDurationSec: 30, subtitleLanguage: "ur" } },
    env.MAX_SCRIPT_CHARS,
  );
  await db.update(projects).set({ status: "QUEUED", runCount: 1 }).where(eq(projects.id, p.id));

  const providers = mockProviderSet({ video: { primary: new FfmpegMotionVideoProvider(), fallback: null } });
  const t0 = Date.now();
  const outcome = await runPipeline({ db, storage: getStorage(), providers, env }, p.id);
  const status = await getProjectStatus(db, p.id);
  console.log(`Project ${p.id}: ${outcome} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (status.error) console.log(`Error: ${status.error}`);
  if (status.finalAssetId) {
    const [a] = await db.select().from(assets).where(eq(assets.id, status.finalAssetId));
    console.log(`Final video asset ${a!.id}: ${path.resolve(env.STORAGE_LOCAL_DIR, a!.storageKey)}`);
  }
  await closeDb();
  process.exit(outcome === "COMPLETED" ? 0 : 1);
}

void main();
