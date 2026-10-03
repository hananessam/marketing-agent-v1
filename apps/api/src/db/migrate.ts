import "../env";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { db, schema } from "./index";

/** Applies SQL migrations from ./drizzle (generate them with `npm run db:generate -w api` after changing schema.ts) and makes sure the default workspace exists. */
migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });

const workspaceId = process.env.DEFAULT_WORKSPACE_ID ?? "ws_demo";
db.insert(schema.workspaces).values({ id: workspaceId, name: "Default Workspace" }).onConflictDoNothing().run();
console.log(`Database ready (workspace ${workspaceId}).`);
