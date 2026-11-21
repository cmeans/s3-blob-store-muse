// server/src/schema.ts and the drizzle/ migrations agree (issue #19).
//
// Applies drizzle/ to an empty in-memory SQLite database with drizzle's own
// migrator, then compares what it built with what schema.ts declares:
// - the same tables, and no others;
// - in each, the same columns, with the same SQL type, NOT NULL, primary
//   key (composite ones included), AUTOINCREMENT and SQL default (as SQL
//   text: a string as its quoted literal, an expression as written);
// - the same indexes (by columns and uniqueness; unique() columns and
//   unique constraints count as unique indexes, as SQLite builds them), the
//   same foreign keys (columns, target table and columns, ON DELETE and ON
//   UPDATE), and the same named CHECK constraints (by name);
// - the same views, by name.
// A table edit in schema.ts committed without its migration (or a
// migration without its schema.ts edit) fails here.
//
// Not compared: a view's query (only its name); triggers, which schema.ts
// can't declare, so a migration's trigger passes unseen; a CHECK's
// expression (only its name) and unnamed CHECKs; an index's WHERE clause;
// and $defaultFn defaults, which run in JS and never reach SQL. Names are
// compared as written, case included, though SQLite ignores case in them:
// a schema.ts name and its migration's should match exactly anyway. The
// journal itself (every .sql in it, in order) is checked by
// .github/scripts/check-drizzle-journal.sh.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getTableConfig, getViewConfig, SQLiteSyncDialect, SQLiteTable, SQLiteView } from "drizzle-orm/sqlite-core";
import { fileURLToPath } from "node:url";
import * as schema from "../src/schema";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const dialect = new SQLiteSyncDialect();

// Defaults are compared as SQL text: a string as its quoted literal
// ('plain'), a number as itself, NULL as NULL, an expression as written.
// So a string default and an expression with the same text differ, as they
// do in the rows they give.
//
// SQLite reports a default expression without its outer parentheses
// (DEFAULT (unixepoch()) comes back as unixepoch()), and drizzle-kit may
// add a pair, so balanced outer parentheses are stripped from both sides.
function stripParens(s: string): string {
  for (;;) {
    s = s.trim();
    if (!s.startsWith("(")) return s;
    let depth = 0;
    let end = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end !== s.length - 1) return s; // "(1) + (2)": not one outer pair
    s = s.slice(1, -1);
  }
}

/** A JS default value as the SQL literal it's stored as. */
const literal = (v: unknown) =>
  v === null ? "NULL" : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v);

/** SQLite's TRUE and FALSE are 1 and 0; drizzle stores a boolean as 1 or 0. */
const normalizeDefault = (s: string) => {
  const t = stripParens(s);
  return /^true$/i.test(t) ? "1" : /^false$/i.test(t) ? "0" : t;
};

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

/** The indexes, foreign keys and named checks schema.ts declares, table by table. */
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

/** The columns schema.ts declares, table by table. */
function declared(): Record<string, Record<string, Column>> {
  const out: Record<string, Record<string, Column>> = {};
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    // A composite primaryKey() leaves each column's `primary` false.
    const inCompositeKey = (name: string) => config.primaryKeys.some((pk) => pk.columns.some((k) => k.name === name));
    const columns: Record<string, Column> = {};
    for (const c of config.columns) {
      let sqlDefault: string | null = null;
      if (c.default !== undefined && typeof c.default !== "function") {
        sqlDefault =
          typeof c.default === "object" && c.default !== null && "queryChunks" in c.default
            ? normalizeDefault(dialect.sqlToQuery(c.default as never).sql) // a sql`` default
            : normalizeDefault(literal(c.mapToDriverValue(c.default))); // a value, as its SQL literal
      }
      const type = c.getSQLType().toUpperCase();
      columns[c.name] = {
        type,
        notNull: rowidAlias(c.primary, type) ? true : c.notNull,
        primaryKey: c.primary || inCompositeKey(c.name),
        autoIncrement: (c as { autoIncrement?: boolean }).autoIncrement === true,
        default: sqlDefault,
      };
    }
    out[config.name] = columns;
  }
  return out;
}

// A single-column INTEGER PRIMARY KEY is the rowid and can't hold NULL,
// though table_info reports it nullable when NOT NULL isn't written. Any
// other primary key column can hold NULL in SQLite unless NOT NULL is
// written, so NOT NULL is compared as written there.
function rowidAlias(singlePrimaryKey: boolean, type: string): boolean {
  return singlePrimaryKey && type === "INTEGER";
}

/** The views schema.ts declares, by name. */
function declaredViews(): string[] {
  return Object.values(schema)
    .filter((v) => is(v, SQLiteView))
    .map((v) => getViewConfig(v as SQLiteView).name)
    .sort();
}

/** The views the migrations built, by name. */
function builtViews(): string[] {
  const sqlite = migrated();
  const names = (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();
  sqlite.close();
  return names;
}

/** The migrated database's own tables: not SQLite's, not drizzle's journal. */
function tablesOf(sqlite: Database): { name: string; sql: string }[] {
  return sqlite
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != '__drizzle_migrations'",
    )
    .all() as { name: string; sql: string }[];
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
  const out: Record<string, Shape> = {};
  for (const t of tablesOf(sqlite)) {
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
    const checks = [...t.sql.matchAll(/CONSTRAINT\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))\s+CHECK\b/gi)].map(
      (m) => (m[1]?.replace(/""/g, '"') ?? m[2] ?? m[3] ?? m[4])!,
    );
    out[t.name] = { indexes: indexes.sort(), foreignKeys: foreignKeys.sort(), checks: checks.sort() };
  }
  sqlite.close();
  return out;
}

/** The columns the migrations built, table by table. */
function built(): Record<string, Record<string, Column>> {
  const sqlite = migrated();
  const out: Record<string, Record<string, Column>> = {};
  for (const t of tablesOf(sqlite)) {
    const info = sqlite.query(`PRAGMA table_info(${quoteId(t.name)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const autoIncrement = /\bAUTOINCREMENT\b/i.test(t.sql);
    const singleKey = info.filter((c) => c.pk > 0).length === 1;
    const columns: Record<string, Column> = {};
    for (const c of info) {
      const type = c.type.toUpperCase();
      columns[c.name] = {
        type,
        notNull: rowidAlias(singleKey && c.pk > 0, type) ? true : c.notnull === 1,
        primaryKey: c.pk > 0,
        // SQLite allows AUTOINCREMENT only on an INTEGER PRIMARY KEY, so a
        // table's keyword belongs to its primary key column.
        autoIncrement: autoIncrement && c.pk > 0,
        default: c.dflt_value === null ? null : normalizeDefault(c.dflt_value),
      };
    }
    out[t.name] = columns;
  }
  sqlite.close();
  return out;
}

// The comparisons below are of sorted lists of one-line strings, each
// starting with its table (and column): bun prints only a few lines of
// context around a diff, so each changed line has to say where it is.

/** One line per column: "history.size: {...}". */
const columnLines = (tables: Record<string, Record<string, Column>>) =>
  Object.entries(tables)
    .flatMap(([table, cols]) => Object.entries(cols).map(([name, c]) => `${table}.${name}: ${JSON.stringify(c)}`))
    .sort();

/** One line per index, foreign key and check: "history index: label unique". */
const shapeLines = (tables: Record<string, Shape>) =>
  Object.entries(tables)
    .flatMap(([table, s]) => [
      ...s.indexes.map((i) => `${table} index: ${i}`),
      ...s.foreignKeys.map((f) => `${table} foreign key: ${f}`),
      ...s.checks.map((c) => `${table} check: ${c}`),
    ])
    .sort();

test("schema.ts declares at least one table", () => {
  expect(Object.keys(declared()).length).toBeGreaterThan(0);
});

test("the migrations build the tables schema.ts declares, and no others", () => {
  expect(Object.keys(built()).sort()).toEqual(Object.keys(declared()).sort());
});

test("each table's columns match schema.ts", () => {
  expect(columnLines(built())).toEqual(columnLines(declared()));
});

test("each table's indexes, unique constraints, foreign keys and checks match schema.ts", () => {
  expect(shapeLines(builtShapes())).toEqual(shapeLines(declaredShapes()));
});

test("the migrations build the views schema.ts declares, and no others", () => {
  expect(builtViews()).toEqual(declaredViews());
});
