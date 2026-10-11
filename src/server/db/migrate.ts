import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "./client";

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("db", "migrate.ts"));
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log("Migrations applied.");
      await closeDb();
    })
    .catch(async (err: unknown) => {
      console.error("Migration failed:", err);
      await closeDb();
      process.exit(1);
    });
}
