import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { users } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { getStorage } from "@/server/storage";

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  const db = getDb();
  await db.execute(sql`TRUNCATE users, sessions, projects RESTART IDENTITY CASCADE`);
}

export async function createUser(email = `user-${Math.random().toString(36).slice(2)}@example.com`) {
  const [u] = await getDb().insert(users).values({ email, passwordHash: "x" }).returning();
  return u!;
}

export function deps(providers: import("@/server/providers/types").ProviderSet) {
  return { db: getDb(), storage: getStorage(), providers, env: getEnv() };
}

export const SAMPLE_SCRIPT = `Shehzada Zain aur Jadui Chiragh.
Ek zamane ki baat hai, Crystal Palace mein Shehzada Zain rehta tha. Ek raat usay ek sunehra chiragh mila.
Zain ne kaha: "Yeh chiragh kaisa hai?" Achanak Pari Noor zahir hui aur boli: "Main tumhari madad karungi."
Dono ne mil kar saltanat ko andheron se bachaya aur roshni wapas aa gayi.`;
