// Behavior tests for server/src/actions.ts (issue #20).
//
// Run with bun from the repo root: `bun test server/test`. Needs zod and
// drizzle-orm (the versions package.json pins) in node_modules, but not the
// Space SDK: @hatch/space-sdk is replaced by ./sdk-stub.ts. CI's step
// "Server tests pass" installs exactly those two and runs this.
//
// - The database is real SQL: drizzle-orm on an in-memory bun:sqlite, set up
//   by drizzle's own migrator from this repo's drizzle/ folder. The Space's
//   own driver isn't known here (the SDK peer-depends on @libsql/client, so
//   it may be libsql), so driver-specific behavior isn't covered.
// - The store is ./fake-store.ts, a local HTTP fake of the store's contract.
// - Each call validates the request with the action's zod schema, runs the
//   handler, and validates the response. That the Space runtime does the
//   same around a handler is assumed, not verified. A refused request never
//   reaches the handler.
//
// What these can't check: the real SDK's types and runtime (Muse's typecheck
// on code PRs covers the types), the real store (the fake follows its
// handler as of the commit fake-store.ts names), and the 30 s timeout on
// store calls.

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import { deadUrl, startFakeStore, STORE_LABEL_RE } from "./fake-store";

mock.module("@hatch/space-sdk", () => import("./sdk-stub"));
const { Actions } = await import("../src/actions");
const schema = await import("../src/schema");

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

const UNAUTHORIZED = "Unauthorized (HTTP 401) — the store rejected the token.";
const FORBIDDEN =
  "Forbidden (HTTP 403) — AWS refused the call before it reached the store. Check the deploy's Function URL permission, and that this is the store's URL.";
const UNREACHABLE = "Unreachable — the store did not answer.";
const NO_CONFIG = "No store is configured yet — save the Function URL and token first.";

type Action = {
  request: { parse(v: unknown): unknown };
  response: { parse(v: unknown): unknown };
  handler(ctx: unknown, args: unknown): Promise<unknown>;
};

const store = startFakeStore("right-token");
afterAll(() => store.stop());

let db: ReturnType<typeof drizzle<typeof schema>>;
let invalidations = 0;
const ctx = {
  db: () => db,
  invalidateQueries: () => {
    invalidations++;
  },
};

beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  invalidations = 0;
  store.blobs.clear();
  store.requests.length = 0;
  store.answer = null;
  store.location = null;
});

/** Validate the request, run the handler, validate the response. */
async function call(name: keyof typeof Actions, args: unknown = {}): Promise<any> {
  const action = Actions[name] as unknown as Action;
  const parsed = action.request.parse(args);
  const result = await action.handler(ctx, parsed);
  action.response.parse(result);
  return result;
}

/** The request's zod error messages, or null when it's accepted. */
function refusal(name: keyof typeof Actions, args: unknown): string[] | null {
  const action = Actions[name] as unknown as { request: { safeParse(v: unknown): any } };
  const r = action.request.safeParse(args);
  return r.success ? null : r.error.issues.map((i: { message: string }) => i.message);
}

/** Save a config directly, so a test can point at the http:// fake. */
async function configure(functionUrl = store.url, token = store.token) {
  await db.insert(schema.config).values({ id: 1, functionUrl, token });
}

const history = () => db.select().from(schema.history).all();

describe("saveConfig and getConfigState", () => {
  test("nothing saved: not configured", async () => {
    expect(await call("getConfigState")).toEqual({ configured: false, functionUrl: null });
  });

  test("saves, reports the URL, never the token", async () => {
    const res = await call("saveConfig", { functionUrl: "https://a.example/", token: "s3cret" });
    expect(res).toEqual({ configured: true, functionUrl: "https://a.example/" });
    expect(invalidations).toBe(1);
    const state = await call("getConfigState");
    expect(state).toEqual({ configured: true, functionUrl: "https://a.example/" });
    expect(JSON.stringify([res, state])).not.toContain("s3cret");
  });

  test("a second save replaces the first (one row)", async () => {
    await call("saveConfig", { functionUrl: "https://a.example", token: "one" });
    await call("saveConfig", { functionUrl: "https://b.example", token: "two" });
    const rows = db.select().from(schema.config).all();
    expect(rows).toEqual([{ id: 1, functionUrl: "https://b.example", token: "two" }]);
  });

  test("trims both fields", async () => {
    await call("saveConfig", { functionUrl: "  https://a.example  ", token: "  t  " });
    expect(db.select().from(schema.config).all()[0]).toMatchObject({
      functionUrl: "https://a.example",
      token: "t",
    });
  });

  test.each([
    [{ functionUrl: "", token: "t" }, "Enter the Function URL."],
    [{ functionUrl: "not a url", token: "t" }, "That doesn't look like a URL."],
    [{ functionUrl: "http://a.example", token: "t" }, "The Function URL must start with https://"],
    [{ functionUrl: "https://a.example", token: "   " }, "Enter the bearer token."],
  ])("refuses %j", (args, message) => {
    expect(refusal("saveConfig", args)).toContain(message);
  });

  test("length limits: URL 2048, token 4096", () => {
    const url = (n: number) => "https://a.example/" + "p".repeat(n - "https://a.example/".length);
    expect(refusal("saveConfig", { functionUrl: url(2048), token: "t" })).toBeNull();
    expect(refusal("saveConfig", { functionUrl: url(2049), token: "t" })).not.toBeNull();
    expect(refusal("saveConfig", { functionUrl: url(20), token: "t".repeat(4096) })).toBeNull();
    expect(refusal("saveConfig", { functionUrl: url(20), token: "t".repeat(4097) })).not.toBeNull();
  });
});

describe("testConnection", () => {
  test("not configured", async () => {
    expect(await call("testConnection")).toEqual({
      status: "not_configured",
      httpStatus: null,
      message: "No store configured — save the Function URL and token first.",
    });
    expect(store.requests).toEqual([]);
  });

  test("ok, with the saved token on GET /", async () => {
    await configure();
    expect(await call("testConnection")).toEqual({
      status: "ok",
      httpStatus: 200,
      message: "Connected — the store answered ok and accepted the token.",
    });
    expect(store.requests).toEqual([{ method: "GET", path: "/", auth: true }]);
  });

  test("trailing slashes on the URL are stripped before the path is added", async () => {
    // Watch the URL actions.ts passes to fetch: bun's fetch itself sends
    // "//" as "/", so the store's view alone wouldn't show the stripping.
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await configure(`${store.url}//`);
      expect((await call("testConnection")).status).toBe("ok");
      await call("fetchBlob", { label: "a" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual([`${store.url}/`, `${store.url}/blobs/a`]);
  });

  test("a redirect isn't followed, so the token goes nowhere else", async () => {
    await configure();
    store.answer = 302;
    store.location = `${store.url}/elsewhere`;
    expect(await call("testConnection")).toEqual({
      status: "error",
      httpStatus: 302,
      message: "Unexpected answer from the store (HTTP 302).",
    });
    expect(store.requests).toEqual([{ method: "GET", path: "/", auth: true }]);
  });

  test("401: the store rejected the token", async () => {
    await configure(store.url, "wrong-token");
    expect(await call("testConnection")).toEqual({
      status: "unauthorized",
      httpStatus: 401,
      message: UNAUTHORIZED,
    });
  });

  test("403 is forbidden, not unauthorized", async () => {
    await configure();
    store.answer = 403;
    expect(await call("testConnection")).toEqual({
      status: "forbidden",
      httpStatus: 403,
      message: FORBIDDEN,
    });
  });

  test("another status is an error with its code", async () => {
    await configure();
    store.answer = 502;
    expect(await call("testConnection")).toEqual({
      status: "error",
      httpStatus: 502,
      message: "Unexpected answer from the store (HTTP 502).",
    });
  });

  test("nothing listening: unreachable", async () => {
    await configure(deadUrl());
    expect(await call("testConnection")).toEqual({
      status: "unreachable",
      httpStatus: null,
      message: "Unreachable — the Function URL did not answer. Check the URL and try again.",
    });
  });
});

describe("storeBlob, fetchBlob, deleteBlob", () => {
  test("each needs a saved config", async () => {
    for (const [name, args] of [
      ["fetchBlob", { label: "a" }],
      ["storeBlob", { label: "a", content: "x" }],
      ["deleteBlob", { label: "a" }],
    ] as const) {
      await expect(call(name, args)).rejects.toThrow(NO_CONFIG);
    }
    expect(store.requests).toEqual([]);
  });

  test("store, fetch and delete round trip, each recorded", async () => {
    await configure();
    expect(await call("storeBlob", { label: "setup-check", content: "ciphertext-xyz" })).toEqual({
      ok: true,
      status: 200,
      message: 'Stored 14 characters under "setup-check".',
    });
    expect(store.blobs.get("setup-check")).toBe("ciphertext-xyz");

    expect(await call("fetchBlob", { label: "setup-check" })).toEqual({
      found: true,
      content: "ciphertext-xyz",
      status: 200,
      message: "Fetched 14 characters.",
    });

    expect(await call("deleteBlob", { label: "setup-check" })).toEqual({
      ok: true,
      status: 200,
      message:
        'The store answered deleted for "setup-check" (it says so even if nothing was stored there).',
    });
    expect(store.blobs.has("setup-check")).toBe(false);

    expect(await call("fetchBlob", { label: "setup-check" })).toEqual({
      found: false,
      content: null,
      status: 404,
      message: 'Not found — no blob under "setup-check".',
    });

    expect(history().map((h) => [h.label, h.action, h.size])).toEqual([
      ["setup-check", "stored", 14],
      ["setup-check", "fetched", 14],
      ["setup-check", "deleted", null],
    ]);
    expect(invalidations).toBe(3);
    expect(store.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /blobs/setup-check",
      "GET /blobs/setup-check",
      "DELETE /blobs/setup-check",
      "GET /blobs/setup-check",
    ]);
  });

  test("delete says what the store answered even when nothing was there", async () => {
    await configure();
    const res = await call("deleteBlob", { label: "never-stored" });
    expect(res.ok).toBe(true);
    expect(res.message).toBe(
      'The store answered deleted for "never-stored" (it says so even if nothing was stored there).',
    );
  });

  test("an empty blob stores and fetches as 0 characters", async () => {
    await configure();
    expect((await call("storeBlob", { label: "e", content: "" })).message).toBe(
      'Stored 0 characters under "e".',
    );
    expect(await call("fetchBlob", { label: "e" })).toMatchObject({
      found: true,
      content: "",
      message: "Fetched 0 characters.",
    });
  });

  // Every failure: the same message for 401 and for 403 in all three
  // actions, the action's own message for another status, and nothing
  // recorded or invalidated.
  const failures = [
    ["fetchBlob", { label: "a" }, "Fetch failed"],
    ["storeBlob", { label: "a", content: "x" }, "Store failed"],
    ["deleteBlob", { label: "a" }, "Delete failed"],
  ] as const;

  for (const [name, args, failed] of failures) {
    const okKey = name === "fetchBlob" ? "found" : "ok";
    const extra = name === "fetchBlob" ? { content: null } : {};

    test(`${name}: 401`, async () => {
      await configure(store.url, "wrong-token");
      expect(await call(name, args)).toEqual({
        [okKey]: false,
        ...extra,
        status: 401,
        message: UNAUTHORIZED,
      });
      expect(history()).toEqual([]);
      expect(invalidations).toBe(0);
    });

    test(`${name}: 403 is forbidden, not a rejected token`, async () => {
      await configure();
      store.answer = 403;
      expect(await call(name, args)).toEqual({
        [okKey]: false,
        ...extra,
        status: 403,
        message: FORBIDDEN,
      });
      expect(history()).toEqual([]);
    });

    test(`${name}: another status`, async () => {
      await configure();
      store.answer = 500;
      expect(await call(name, args)).toEqual({
        [okKey]: false,
        ...extra,
        status: 500,
        message: `${failed} (HTTP 500).`,
      });
      expect(history()).toEqual([]);
    });

    test(`${name}: a 2xx other than 200 isn't success`, async () => {
      await configure();
      store.answer = 204;
      expect(await call(name, args)).toEqual({
        [okKey]: false,
        ...extra,
        status: 204,
        message: `${failed} (HTTP 204).`,
      });
      expect(history()).toEqual([]);
    });

    test(`${name}: a redirect isn't followed`, async () => {
      await configure();
      store.answer = 302;
      store.location = `${store.url}/elsewhere`;
      expect((await call(name, args)).status).toBe(302);
      expect(store.requests).toHaveLength(1);
      expect(history()).toEqual([]);
    });

    test(`${name}: unreachable`, async () => {
      await configure(deadUrl());
      expect(await call(name, args)).toEqual({
        [okKey]: false,
        ...extra,
        status: null,
        message: UNREACHABLE,
      });
      expect(history()).toEqual([]);
      expect(invalidations).toBe(0);
    });
  }

  test("the store refuses a body with U+FFFD; the console reports its 400", async () => {
    await configure();
    expect(await call("storeBlob", { label: "u", content: "a�b" })).toEqual({
      ok: false,
      status: 400,
      message: "Store failed (HTTP 400).",
    });
    expect(store.blobs.has("u")).toBe(false);
    expect(history()).toEqual([]);
  });

  test("content over 5,000,000 characters is refused before the store", () => {
    expect(refusal("storeBlob", { label: "a", content: "x".repeat(5_000_001) })).toEqual([
      "That blob is too large for the store (6 MB limit).",
    ]);
    expect(refusal("storeBlob", { label: "a", content: "x".repeat(5_000_000) })).toBeNull();
  });
});

describe("labels follow the store's rule", () => {
  // Accepted by the store's LABEL_RE (fake-store.ts) or not; the console must
  // agree on each, after its trim.
  const labels = [
    "a",
    "A",
    "0",
    "setup-check",
    "a.b_c-d",
    "a..b",
    "9-lives",
    "x".repeat(128),
    "a".padEnd(128, "."),
    " padded ",
    ".",
    "..",
    ".x",
    "-a",
    "_a",
    "",
    "   ",
    "x".repeat(129),
    "a/b",
    "a b",
    "a%2Fb",
    "é",
    "a+b",
    "a:b",
    "a\u0000b",
  ];

  test.each(labels.map((l) => [JSON.stringify(l), l]))("%s: console agrees with the store", (_, label) => {
    const consoleAccepts = refusal("fetchBlob", { label }) === null;
    expect(consoleAccepts).toBe(STORE_LABEL_RE.test(label.trim()));
  });

  test("a label the console accepts round-trips through the store", async () => {
    await configure();
    for (const label of labels.filter((l) => refusal("storeBlob", { label: l, content: "" }) === null)) {
      expect((await call("storeBlob", { label, content: `blob ${label}` })).ok).toBe(true);
      // Stored under the trimmed label, as the console sends it.
      expect(store.blobs.get(label.trim())).toBe(`blob ${label}`);
      expect((await call("fetchBlob", { label })).content).toBe(`blob ${label}`);
    }
  });

  test("the refusal messages", () => {
    expect(refusal("fetchBlob", { label: "" })).toContain("Enter a label.");
    expect(refusal("fetchBlob", { label: "x".repeat(129) })).toContain(
      "Labels are at most 128 characters.",
    );
    expect(refusal("fetchBlob", { label: ".." })).toEqual([
      "Labels start with a letter or digit, then use letters, digits, dot, dash and underscore.",
    ]);
  });

  test("a refused label is refused by every action that takes one, before the handler", async () => {
    await configure();
    for (const [name, args] of [
      ["fetchBlob", { label: ".." }],
      ["storeBlob", { label: "..", content: "x" }],
      ["deleteBlob", { label: ".." }],
      ["registerExternalOperation", { label: "..", action: "stored" }],
    ] as const) {
      await expect(call(name, args)).rejects.toThrow();
    }
    expect(store.requests).toEqual([]);
    expect(history()).toEqual([]);
  });
});

describe("listHistory and registerExternalOperation", () => {
  test("empty at first", async () => {
    expect(await call("listHistory", {})).toEqual({ entries: [] });
  });

  test("records an outside operation without contacting the store", async () => {
    await configure();
    const a = await call("registerExternalOperation", { label: "ext", action: "stored", size: 42 });
    const b = await call("registerExternalOperation", { label: "ext", action: "deleted" });
    expect(b.id).toBeGreaterThan(a.id);
    expect(store.requests).toEqual([]);
    expect(invalidations).toBe(2);
    expect(history().map((h) => [h.id, h.label, h.action, h.size])).toEqual([
      [a.id, "ext", "stored", 42],
      [b.id, "ext", "deleted", null],
    ]);
  });

  test("lists newest first, with ISO times, up to the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await call("registerExternalOperation", { label: `l${i}`, action: "fetched", size: i });
    }
    const all = await call("listHistory", {});
    expect(all.entries.map((e: { label: string }) => e.label)).toEqual(["l4", "l3", "l2", "l1", "l0"]);
    for (const e of all.entries) expect(new Date(e.created_at).toISOString()).toBe(e.created_at);
    const two = await call("listHistory", { limit: 2 });
    expect(two.entries.map((e: { label: string }) => e.label)).toEqual(["l4", "l3"]);
  });

  test.each([[0], [201], [1.5], [-1]])("refuses limit %p", (limit) => {
    expect(refusal("listHistory", { limit })).not.toBeNull();
  });

  test.each([[-1], [6_000_001], [1.5]])("refuses size %p", (size) => {
    expect(refusal("registerExternalOperation", { label: "a", action: "stored", size })).not.toBeNull();
  });
});
