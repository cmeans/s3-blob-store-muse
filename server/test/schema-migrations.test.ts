// server/src/schema.ts and the drizzle/ migrations agree (issue #19).
//
// Applies drizzle/ to an empty in-memory SQLite database with drizzle's own
// migrator, then compares what it built with what schema.ts declares:
// - the same tables, and no others;
// - in each, the same columns, with the same SQL type, NOT NULL, primary
//   key, AUTOINCREMENT and SQL default;
// - the same indexes (by columns and uniqueness; unique() columns and
//   unique constraints count as unique indexes, as SQLite builds them), the
//   same foreign keys (columns, target table and columns, ON DELETE and ON
//   UPDATE), and the same named CHECK constraints (by name).
// A schema.ts edit committed without its migration (or a migration without
// its schema.ts edit) fails here.
//
// Not compared: a CHECK's expression (only its name), an index's WHERE
// clause, and $defaultFn defaults, which run in JS and never reach SQL. The
// journal itself (every .sql in it, in order) is checked by
// .github/scripts/check-drizzle-journal.sh.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { fileURLToPath } from "node:url";
import * as schema from "../src/schema";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

type Column = {
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  default: string | null;
};

type Shape = {
  /** "a,b" or "a,b unique", sorted. */
  indexes: string[];
  /** "a,b -> other(x,y) delete:cascade update:no action", sorted. */
  foreignKeys: string[];
  /** Constraint names, sorted. */
  checks: string[];
};

const fkAction = (a: string | undefined) => (a ?? "no action").toLowerCase();

/** What schema.ts declares, table by table. */
function declaredShapes(): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const indexes = config.indexes.map(
      (i) =>
        i.config.columns.map((c) => (c as { name: string }).name).join(",") +
        (i.config.unique ? " unique" : ""),
    );
    for (const u of config.uniqueConstraints) indexes.push(`${u.columns.map((c) => c.name).join(",")} unique`);
    for (const c of config.columns) if (c.isUnique) indexes.push(`${c.name} unique`);
    const foreignKeys = config.foreignKeys.map((fk) => {
      const r = fk.reference();
      return `${r.columns.map((c) => c.name).join(",")} -> ${getTableConfig(r.foreignTable).name}(${r.foreignColumns
        .map((c) => c.name)
        .join(",")}) delete:${fkAction(fk.onDelete)} update:${fkAction(fk.onUpdate)}`;
    });
    out[config.name] = {
      indexes: indexes.sort(),
      foreignKeys: foreignKeys.sort(),
      checks: config.checks.map((c) => c.name).sort(),
    };
  }
  return out;
}

/** What schema.ts declares, table by table. */
function declared(): Record<string, Record<string, Column>> {
  const out: Record<string, Record<string, Column>> = {};
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    const columns: Record<string, Column> = {};
    for (const c of config.columns) {
      const sqlDefault =
        c.default === undefined || typeof c.default === "function"
          ? null
          : typeof c.default === "object" && c.default !== null && "queryChunks" in c.default
            ? "(sql)" // a sql`` default: compared only as present
            : String(c.default);
      columns[c.name] = {
        type: c.getSQLType().toUpperCase(),
        // SQLite's table_info reports a primary key column as nullable
        // unless NOT NULL is written; drizzle marks it notNull. Compare
        // NOT NULL on the other columns only.
        notNull: c.primary ? false : c.notNull,
        primaryKey: c.primary,
        autoIncrement: (c as { autoIncrement?: boolean }).autoIncrement === true,
        default: sqlDefault,
      };
    }
    out[config.name] = columns;
  }
  return out;
}

/** A fresh database with every migration applied. */
function migrated(): Database {
  const sqlite = new Database(":memory:");
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
  return sqlite;
}

const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The indexes, foreign keys and named checks the migrations built. */
function builtShapes(): Record<string, Shape> {
  const sqlite = migrated();
  const tables = sqlite
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all() as { name: string; sql: string }[];
  const out: Record<string, Shape> = {};
  for (const t of tables) {
    const indexes: string[] = [];
    const list = sqlite.query(`PRAGMA index_list(${quoteId(t.name)})`).all() as {
      name: string;
      unique: number;
      origin: string;
    }[];
    for (const i of list) {
      if (i.origin === "pk") continue; // the primary key, compared as columns
      const cols = sqlite.query(`PRAGMA index_info(${quoteId(i.name)})`).all() as { name: string }[];
      indexes.push(cols.map((c) => c.name).join(",") + (i.unique ? " unique" : ""));
    }
    const fkRows = sqlite.query(`PRAGMA foreign_key_list(${quoteId(t.name)})`).all() as {
      id: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }[];
    const byId = new Map<number, typeof fkRows>();
    for (const r of fkRows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    const foreignKeys = [...byId.values()].map((rows) => {
      const first = rows[0]!;
      return `${rows.map((r) => r.from).join(",")} -> ${first.table}(${rows.map((r) => r.to).join(",")}) delete:${first.on_delete.toLowerCase()} update:${first.on_update.toLowerCase()}`;
    });
    const checks = [...t.sql.matchAll(/CONSTRAINT\s+["`]?([^"`\s]+)["`]?\s+CHECK\b/gi)].map((m) => m[1]!);
    out[t.name] = { indexes: indexes.sort(), foreignKeys: foreignKeys.sort(), checks: checks.sort() };
  }
  sqlite.close();
  return out;
}

/** What the migrations built, table by table. */
function built(): Record<string, Record<string, Column>> {
  const sqlite = migrated();
  const tables = sqlite
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all() as { name: string; sql: string }[];
  const out: Record<string, Record<string, Column>> = {};
  for (const t of tables) {
    const info = sqlite.query(`PRAGMA table_info(${quoteId(t.name)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const autoIncrement = /\bAUTOINCREMENT\b/i.test(t.sql);
    const columns: Record<string, Column> = {};
    for (const c of info) {
      columns[c.name] = {
        type: c.type.toUpperCase(),
        notNull: c.pk > 0 ? false : c.notnull === 1,
        primaryKey: c.pk > 0,
        // SQLite allows AUTOINCREMENT only on an INTEGER PRIMARY KEY, so a
        // table's keyword belongs to its primary key column.
        autoIncrement: autoIncrement && c.pk > 0,
        default: c.dflt_value === null ? null : c.dflt_value.startsWith("(") ? "(sql)" : unquote(c.dflt_value),
      };
    }
    out[t.name] = columns;
  }
  sqlite.close();
  return out;
}

/** SQLite reports a string default with its quotes: 'x' -> x. */
function unquote(v: string): string {
  return /^'.*'$/s.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v;
}

test("schema.ts declares at least one table", () => {
  expect(Object.keys(declared()).length).toBeGreaterThan(0);
});

test("the migrations build the tables schema.ts declares, and no others", () => {
  expect(Object.keys(built()).sort()).toEqual(Object.keys(declared()).sort());
});

test("each table's columns match schema.ts", () => {
  const want = declared();
  const got = built();
  for (const table of Object.keys(want)) {
    // toEqual names the table and column in its diff on a mismatch.
    expect({ [table]: got[table] }).toEqual({ [table]: want[table] });
  }
});

test("each table's indexes, unique constraints, foreign keys and checks match schema.ts", () => {
  const want = declaredShapes();
  const got = builtShapes();
  for (const table of Object.keys(want)) {
    expect({ [table]: got[table] }).toEqual({ [table]: want[table] });
  }
});
