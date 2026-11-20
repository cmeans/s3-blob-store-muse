# s3-blob-store-muse

The operator console for
[s3-blob-store](https://github.com/cmeans/s3-blob-store), built as a
Muse Space (a hosted full-stack web app in the Muse personal-agent
environment). It gives a human a one-screen console over the blob
store: configure the store's endpoint once, then fetch, store, and
delete ciphertext blobs by label, with a history of what the console
has done.

The store itself lives in the parent repo. This repo is only the
console.

## Why source, not a link

A server-backed Space cannot be published at a public link — only
static pages can. So the shareable form of this console is its
source tree, published here. To run your own:

- In Muse, create a new full-stack Space and give Muse this source
  tree as the starting point (the layout below is the standard Muse
  Space layout), or
- Read `server/src/actions.ts` as a reference implementation and put
  any front end you like over the same store API.

Nothing is configured in the source. The operator enters the store's
Function URL and bearer token in the console's setup screen at
runtime; both are stored server-side by the Space, and the token is
never sent back to the browser.

## Layout

- `client/` — the React front end (`src/App.tsx` is the whole
  console: setup, blob operations, history).
- `server/src/actions.ts` — the backend wiring. Every store call is
  made server-side with the saved token in an `Authorization: Bearer`
  header:
  - `saveConfig` / `getConfigState` — persist and report the
    Function URL and token (state reports the URL and "token saved"
    only).
  - `testConnection` — `GET /` on the store; reports ok,
    unauthorized, and unreachable distinctly.
  - `fetchBlob` / `storeBlob` / `deleteBlob` — `GET` / `PUT` /
    `DELETE` on `/blobs/<label>`.
  - `listHistory` / `registerExternalOperation` — the console's own
    operation record (see below).
- `server/src/schema.ts` and `drizzle/` — the Space's own database
  schema and migrations (config + history tables). The database file
  itself is never committed.
- `space.json` — the Space's runtime manifest.

## The history is the console's, not the bucket's

The store cannot list its bucket — its Lambda role has no list
permission, by design. The console therefore keeps its own record of
every fetch, store, and delete it performs (label, action, size,
timestamp) and shows the labels it knows about.
`registerExternalOperation` exists so an agent that stores or fetches
a blob through its own connection can log the operation into the
same history, keeping the console's view complete.

## Security posture, honestly

This console holds the store's bearer token in its own server-side
storage so a human can operate the store without pasting the token
on every visit. That is a weaker posture than the agent fetch path
in the parent pattern, where the token lives in the platform
credential store and is swapped in per request. Treat this as an
operator console for a store whose contents are ciphertext — which
is all the store ever holds. The console's standing rule is printed
at the top of its screen: ciphertext only, never the plaintext
secret.

## Licence

MIT. See `LICENSE`.
