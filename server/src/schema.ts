// Drizzle schema for this space.
//
// One table: `config`, a single-row table (id = 1) holding the operator's
// S3 blob store connection — the Lambda Function URL and its bearer token.
// The token is stored server-side only; no action ever returns it.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const config = sqliteTable("config", {
  id: integer("id").primaryKey(),
  functionUrl: text("function_url").notNull(),
  token: text("token").notNull(),
});

// The console's OWN operation record. The store cannot enumerate its
// bucket, so this table is how the operator knows which labels exist:
// one row per fetch/store/delete performed through this Space, plus any
// operations the agent logs via registerExternalOperation.
export const history = sqliteTable("history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  action: text("action", { enum: ["stored", "fetched", "deleted"] }).notNull(),
  size: integer("size"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
