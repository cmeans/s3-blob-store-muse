// A local HTTP fake of the blob store's contract, for the behavior tests.
//
// It follows the store's handler (cmeans/s3-blob-store, lambda/index.py, as
// of adaa2ac): a bearer token checked on every route (401 "unauthorized"),
// GET / -> 200 "ok", /blobs/<label> with the store's LABEL_RE (400 "invalid
// label"), GET -> 200 text or 404 "not found", PUT -> 200 "stored" or 400
// for a body containing U+FFFD, DELETE -> 200 "deleted" even when nothing was
// stored, anything else 405. A path that isn't / or /blobs/<one segment> is
// 404, as there. Not modeled: the handler's base64 bodies
// (isBase64Encoded) and lone surrogates, which a JS string sent by fetch
// can't carry as such.
//
// `answer` forces one status for every request, for what the handler never
// sends but a caller can still get: 403 from AWS in front of the handler, a
// 5xx, a 2xx other than 200, or a redirect (with `location` as its Location
// header). Blobs live in memory.

// The store's LABEL_RE, from lambda/index.py at adaa2ac.
export const STORE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROUTE_RE = /^\/blobs\/([^/]+)$/;

export type FakeStore = {
  url: string;
  token: string;
  blobs: Map<string, string>;
  /** Requests seen, in order: method, path, and whether a token came with it. */
  requests: { method: string; path: string; auth: boolean }[];
  /** When set, every request gets this status (body "forced"). */
  answer: number | null;
  /** The Location header sent with `answer`, for a redirect. */
  location: string | null;
  stop(): void;
};

export function startFakeStore(token = "test-token"): FakeStore {
  const store: FakeStore = {
    url: "",
    token,
    blobs: new Map(),
    requests: [],
    answer: null,
    location: null,
    stop: () => server.stop(true),
  };
  const reply = (status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(status === 204 ? null : body, {
      status,
      headers: { "Content-Type": "text/plain", ...extra },
    });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      store.requests.push({ method: req.method, path, auth: req.headers.has("authorization") });
      if (store.answer !== null) {
        return reply(store.answer, "forced", store.location ? { Location: store.location } : {});
      }

      const auth = req.headers.get("authorization") ?? "";
      const space = auth.indexOf(" ");
      const scheme = space < 0 ? auth : auth.slice(0, space);
      const presented = space < 0 ? "" : auth.slice(space + 1);
      if (scheme.toLowerCase() !== "bearer" || !presented || presented !== store.token) {
        return reply(401, "unauthorized");
      }
      if (req.method === "GET" && (path === "/" || path === "")) return reply(200, "ok");

      const route = ROUTE_RE.exec(path);
      if (!route) return reply(404, "not found");
      // Decoded here; whether Lambda decodes the path for the handler isn't
      // verified, and it doesn't matter for these tests: every label the
      // console accepts is unchanged by encodeURIComponent.
      const label = decodeURIComponent(route[1] ?? "");
      if (!STORE_LABEL_RE.test(label)) return reply(400, "invalid label");

      if (req.method === "GET") {
        const blob = store.blobs.get(label);
        return blob === undefined ? reply(404, "not found") : reply(200, blob);
      }
      if (req.method === "PUT") {
        const body = await req.text();
        // U+FFFD: a text body's non-UTF-8 bytes arrive replaced by it.
        if (body.includes("\ufffd")) return reply(400, "body must be UTF-8 text (U+FFFD not allowed)");
        store.blobs.set(label, body);
        return reply(200, "stored");
      }
      if (req.method === "DELETE") {
        store.blobs.delete(label);
        return reply(200, "deleted");
      }
      return reply(405, "method not allowed");
    },
  });
  store.url = `http://127.0.0.1:${server.port}`;
  return store;
}

/** A URL nothing listens on: a port the OS just handed out and took back. */
export function deadUrl(): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}
