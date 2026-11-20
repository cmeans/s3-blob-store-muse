// Actions for the S3 blob store operator console.
//
// The store is a Lambda Function URL front door over a private S3 bucket.
// Every store call happens here, server-side, with the saved bearer token
// in the Authorization header. The token is persisted in this artifact's
// own DB and is never returned to the browser: config actions report only
// whether a token is saved, never its value.
//
// Store contract (verified live 2026-11-20 via the connector helper):
//   GET    /              -> 200 "ok" when authorized, 401 when not
//   GET    /blobs/<label> -> 200 blob text, 404 when the label is missing
//   PUT    /blobs/<label> -> 200 "stored" (raw request body is the blob)
//   DELETE /blobs/<label> -> 200 "deleted"
// There is deliberately no list operation.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const CONFIG_ID = 1;

const labelSchema = z
  .string()
  .trim()
  .min(1, "Enter a label.")
  .max(128, "Labels are at most 128 characters.")
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Labels use letters, digits, dot, dash and underscore only.",
  );

type StoredConfig = { functionUrl: string; token: string };

async function loadConfig(ctx: Ctx): Promise<StoredConfig | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.config)
    .where(eq(schema.config.id, CONFIG_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { functionUrl: row.functionUrl, token: row.token };
}

function requireConfig(cfg: StoredConfig | null): StoredConfig {
  if (!cfg) {
    throw new Error("No store is configured yet — save the Function URL and token first.");
  }
  return cfg;
}

/** Join the configured base URL with a path, tolerating a trailing slash. */
function storeUrl(cfg: StoredConfig, path: string): string {
  return cfg.functionUrl.replace(/\/+$/, "") + path;
}

type StoreResult =
  | { kind: "response"; status: number; body: string }
  | { kind: "unreachable" };

async function callStore(
  cfg: StoredConfig,
  method: string,
  path: string,
  body?: string,
): Promise<StoreResult> {
  try {
    const res = await fetch(storeUrl(cfg, path), {
      method,
      headers: { Authorization: `Bearer ${cfg.token}` },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return { kind: "response", status: res.status, body: await res.text() };
  } catch {
    return { kind: "unreachable" };
  }
}

type HistoryAction = "stored" | "fetched" | "deleted";

/** Append one row to the console's own operation record. */
async function recordHistory(
  ctx: Ctx,
  label: string,
  action: HistoryAction,
  size: number | null,
): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db.insert(schema.history).values({ label, action, size });
}

const historyResponse = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      label: z.string(),
      action: z.enum(["stored", "fetched", "deleted"]),
      size: z.number().nullable(),
      created_at: z.string(),
    }),
  ),
});

const registerExternalResponse = z.object({ id: z.number() });

const configStateResponse = z.object({
  configured: z.boolean(),
  functionUrl: z.string().nullable(),
});

const testConnectionResponse = z.object({
  status: z.enum(["ok", "unauthorized", "unreachable", "not_configured", "error"]),
  httpStatus: z.number().nullable(),
  message: z.string(),
});

const fetchBlobResponse = z.object({
  found: z.boolean(),
  content: z.string().nullable(),
  status: z.number().nullable(),
  message: z.string(),
});

const storeBlobResponse = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  message: z.string(),
});

const deleteBlobResponse = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  message: z.string(),
});

export const Actions = {
  saveConfig: defineAction({
    description:
      "Saves the blob store's Lambda Function URL and bearer token server-side. Returns only whether it is configured and the URL — never the token.",
    request: z.object({
      functionUrl: z
        .string()
        .trim()
        .min(1, "Enter the Function URL.")
        .max(2048)
        .url("That doesn't look like a URL.")
        .refine((u) => u.startsWith("https://"), "The Function URL must start with https://"),
      token: z.string().trim().min(1, "Enter the bearer token.").max(4096),
    }),
    response: configStateResponse,
    async handler(ctx, args): Promise<z.infer<typeof configStateResponse>> {
      const db = ctx.db<typeof schema>();
      const existing = await loadConfig(ctx);
      if (existing) {
        await db
          .update(schema.config)
          .set({ functionUrl: args.functionUrl, token: args.token })
          .where(eq(schema.config.id, CONFIG_ID));
      } else {
        await db.insert(schema.config).values({
          id: CONFIG_ID,
          functionUrl: args.functionUrl,
          token: args.token,
        });
      }
      ctx.invalidateQueries();
      return { configured: true, functionUrl: args.functionUrl };
    },
  }),

  getConfigState: defineAction({
    description:
      "Reports whether a store is configured and its Function URL. The token is reported only as saved/not saved — its value never leaves the server.",
    request: z.object({}),
    response: configStateResponse,
    async handler(ctx): Promise<z.infer<typeof configStateResponse>> {
      const cfg = await loadConfig(ctx);
      return {
        configured: cfg != null,
        functionUrl: cfg ? cfg.functionUrl : null,
      };
    },
  }),

  testConnection: defineAction({
    description:
      "Calls GET / on the configured store with the saved token and reports ok, unauthorized, or unreachable as distinct outcomes.",
    request: z.object({}),
    response: testConnectionResponse,
    async handler(ctx): Promise<z.infer<typeof testConnectionResponse>> {
      const cfg = await loadConfig(ctx);
      if (!cfg) {
        return {
          status: "not_configured",
          httpStatus: null,
          message: "No store configured — save the Function URL and token first.",
        };
      }
      const result = await callStore(cfg, "GET", "/");
      if (result.kind === "unreachable") {
        return {
          status: "unreachable",
          httpStatus: null,
          message: "Unreachable — the Function URL did not answer. Check the URL and try again.",
        };
      }
      if (result.status === 200) {
        return {
          status: "ok",
          httpStatus: 200,
          message: "Connected — the store answered ok and accepted the token.",
        };
      }
      if (result.status === 401 || result.status === 403) {
        return {
          status: "unauthorized",
          httpStatus: result.status,
          message: `Unauthorized (HTTP ${result.status}) — the store rejected the token.`,
        };
      }
      return {
        status: "error",
        httpStatus: result.status,
        message: `Unexpected answer from the store (HTTP ${result.status}).`,
      };
    },
  }),

  fetchBlob: defineAction({
    description:
      "Fetches the blob stored under an exact label. A missing label returns found:false rather than an error.",
    request: z.object({ label: labelSchema }),
    response: fetchBlobResponse,
    async handler(ctx, args): Promise<z.infer<typeof fetchBlobResponse>> {
      const cfg = requireConfig(await loadConfig(ctx));
      const result = await callStore(
        cfg,
        "GET",
        `/blobs/${encodeURIComponent(args.label)}`,
      );
      if (result.kind === "unreachable") {
        return {
          found: false,
          content: null,
          status: null,
          message: "Unreachable — the store did not answer.",
        };
      }
      if (result.status === 404) {
        return {
          found: false,
          content: null,
          status: 404,
          message: `Not found — no blob under "${args.label}".`,
        };
      }
      if (result.status === 401 || result.status === 403) {
        return {
          found: false,
          content: null,
          status: result.status,
          message: `Unauthorized (HTTP ${result.status}) — the store rejected the token.`,
        };
      }
      if (result.status !== 200) {
        return {
          found: false,
          content: null,
          status: result.status,
          message: `Fetch failed (HTTP ${result.status}).`,
        };
      }
      await recordHistory(ctx, args.label, "fetched", result.body.length);
      ctx.invalidateQueries();
      return {
        found: true,
        content: result.body,
        status: 200,
        message: `Fetched ${result.body.length} characters.`,
      };
    },
  }),

  storeBlob: defineAction({
    description:
      "Stores the given ciphertext content under a label, creating or replacing the blob. The store has versioning off, so a replace is final.",
    request: z.object({
      label: labelSchema,
      // Lambda Function URLs cap the payload at 6 MB; keep the text under it.
      content: z.string().max(5_000_000, "That blob is too large for the store (6 MB limit)."),
    }),
    response: storeBlobResponse,
    async handler(ctx, args): Promise<z.infer<typeof storeBlobResponse>> {
      const cfg = requireConfig(await loadConfig(ctx));
      const result = await callStore(
        cfg,
        "PUT",
        `/blobs/${encodeURIComponent(args.label)}`,
        args.content,
      );
      if (result.kind === "unreachable") {
        return { ok: false, status: null, message: "Unreachable — the store did not answer." };
      }
      if (result.status === 401 || result.status === 403) {
        return {
          ok: false,
          status: result.status,
          message: `Unauthorized (HTTP ${result.status}) — the store rejected the token.`,
        };
      }
      if (result.status !== 200) {
        return {
          ok: false,
          status: result.status,
          message: `Store failed (HTTP ${result.status}).`,
        };
      }
      await recordHistory(ctx, args.label, "stored", args.content.length);
      ctx.invalidateQueries();
      return {
        ok: true,
        status: 200,
        message: `Stored ${args.content.length} characters under "${args.label}".`,
      };
    },
  }),

  deleteBlob: defineAction({
    description:
      "Deletes the blob under a label and reports the store's answer. Irreversible — the store has versioning off.",
    request: z.object({ label: labelSchema }),
    response: deleteBlobResponse,
    async handler(ctx, args): Promise<z.infer<typeof deleteBlobResponse>> {
      const cfg = requireConfig(await loadConfig(ctx));
      const result = await callStore(
        cfg,
        "DELETE",
        `/blobs/${encodeURIComponent(args.label)}`,
      );
      if (result.kind === "unreachable") {
        return { ok: false, status: null, message: "Unreachable — the store did not answer." };
      }
      if (result.status === 401 || result.status === 403) {
        return {
          ok: false,
          status: result.status,
          message: `Unauthorized (HTTP ${result.status}) — the store rejected the token.`,
        };
      }
      if (result.status !== 200) {
        return {
          ok: false,
          status: result.status,
          message: `Delete failed (HTTP ${result.status}).`,
        };
      }
      await recordHistory(ctx, args.label, "deleted", null);
      ctx.invalidateQueries();
      return {
        ok: true,
        status: 200,
        message: `Deleted "${args.label}".`,
      };
    },
  }),

  listHistory: defineAction({
    description:
      "Lists this console's own record of blob operations, most recent first. This is the console's record only — the store itself cannot list the bucket.",
    request: z.object({
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: historyResponse,
    async handler(ctx, args): Promise<z.infer<typeof historyResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.history)
        .orderBy(desc(schema.history.id))
        .limit(args.limit);
      return {
        entries: rows.map((row) => ({
          id: row.id,
          label: row.label,
          action: row.action,
          size: row.size,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  registerExternalOperation: defineAction({
    description:
      "Records a blob operation the agent performed through its own connection (outside this Space) in the console's history, so the record stays complete. Touches only this app's own storage; takes no token and never contacts the store.",
    request: z.object({
      label: labelSchema,
      action: z.enum(["stored", "fetched", "deleted"]),
      size: z.number().int().nonnegative().max(6_000_000).nullable().optional(),
    }),
    response: registerExternalResponse,
    async handler(ctx, args): Promise<z.infer<typeof registerExternalResponse>> {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.history)
        .values({ label: args.label, action: args.action, size: args.size ?? null })
        .returning({ id: schema.history.id });
      const inserted = result[0];
      if (!inserted) {
        throw new Error("registerExternalOperation: insert returned no rows");
      }
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),
} satisfies ActionsModule;
