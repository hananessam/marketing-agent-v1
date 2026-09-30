import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { createDb, type Db } from "../db/create";
import * as schema from "../db/schema";

/** In-memory DB with the real schema applied. */
export async function createTestDb(): Promise<Db> {
  const db = createDb(":memory:");
  const empty = await generateSQLiteDrizzleJson({});
  const current = await generateSQLiteDrizzleJson(schema as Record<string, unknown>);
  const statements = await generateSQLiteMigration(empty, current);
  for (const s of statements) db.run(s as never);
  return db;
}

export { schema };
