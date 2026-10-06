import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getEnv } from "@/server/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

declare global {
  var __studioPool: pg.Pool | undefined;
  var __studioDb: Db | undefined;
}

/** Lazily-created pooled connection, reused across hot reloads in dev. */
export function getDb(): Db {
  if (globalThis.__studioDb) return globalThis.__studioDb;
  const env = getEnv();
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  globalThis.__studioPool = pool;
  globalThis.__studioDb = drizzle(pool, { schema });
  return globalThis.__studioDb;
}

export async function closeDb(): Promise<void> {
  await globalThis.__studioPool?.end();
  globalThis.__studioPool = undefined;
  globalThis.__studioDb = undefined;
}

export { schema };
