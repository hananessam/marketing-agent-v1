import { createDb } from "./create";
import * as schema from "./schema";

export const db = createDb(process.env.DATABASE_URL ?? "local.db");
export { schema };
export type { Db } from "./create";
