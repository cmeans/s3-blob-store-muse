# s3-blob-store-muse

A one-page operator console for
[s3-blob-store](https://github.com/cmeans/s3-blob-store), built as a
Muse Space (a full-stack web app inside Muse, Meta's personal AI
agent). Point it at your store once, then check the connection and
store, fetch and delete ciphertext blobs by label, with a history of
what the console has done.

**You need this repo if** you run an s3-blob-store, use Muse, and want
a screen for the store your agent already uses: to check that the
store answers, look at what is stored under a label, put a blob there
by hand, or remove one.

**You don't need it** to use the store. Muse reaches the store
through its own connection, without this console. And if you don't
have a deployed store, start with
[s3-blob-store](https://github.com/cmeans/s3-blob-store): this console
does nothing without one.

To install it, see [SETUP.md](SETUP.md). To have your assistant
install and check it for you, point it at [SKILL.md](SKILL.md).

## What it does

The console is one page with three sections, under a line at the top
that reads "Ciphertext only — never the plaintext secret."

- **Setup.** The store's Function URL and bearer token, entered once
  and saved by the Space's server. After saving, the page shows the
  URL and "Token: saved", never the token. **Test connection** calls
  the store's health check and reports one of: connected, unauthorized
  (the store rejected the token), forbidden (AWS refused the call
  before it reached the store), unreachable, no store configured, or
  an unexpected HTTP status. **Edit** replaces them; saving needs both
  again.
- **Blob.** A label field, a text box for the ciphertext, and
  **Fetch**, **Store** and **Delete**. Fetch fills the text box with
  what is stored under the label. Store creates or replaces the blob.
  Delete asks for a second click, because the store keeps no old
  versions. Its message reports the store's answer, "deleted", which
  the store gives even when nothing was stored under the label. A
  blob can be up to 5,000,000 characters of ASCII text, such as base64
  ciphertext (the store's Function URL takes at most 6 MB per
  request).
- **History.** Every fetch, store and delete the console has done
  successfully, newest first, with the labels it knows about and the
  last action on each. Clicking a label puts it in the label field.
  The store itself can't list its bucket, so this record is the only
  list of labels there is (see below).

## How it works

Every store call is made by the Space's server, never the browser.
The browser calls the Space's own actions; the server adds the saved
token as an `Authorization: Bearer` header and calls the store.

- `client/`: the React front end. `src/App.tsx` is the whole page.
- `server/src/actions.ts`: the server actions.
  - `saveConfig` and `getConfigState` save and report the Function URL
    and token. `getConfigState` reports the URL and whether a token is
    saved, never the token.
  - `testConnection` calls `GET /` on the store.
  - `fetchBlob`, `storeBlob` and `deleteBlob` call `GET`, `PUT` and
    `DELETE` on `/blobs/<label>`.
  - `listHistory` and `registerExternalOperation` read and add to the
    console's own record (see below).
- `server/src/schema.ts` and `drizzle/`: the Space's database schema
  and migrations, a one-row `config` table and a `history` table. The
  database file itself is never committed. `drizzle/meta/_journal.json`
  lists the migrations, and drizzle's migrator applies only what it
  lists. To add a migration, add its `.sql` file and a journal entry
  with the next `idx`, the file name (without `.sql`) as `tag`, and a
  `when` later than every earlier entry's. A migration that isn't in
  the journal, or whose `when` isn't later, is skipped without an
  error on a console that already has a database. Never edit a
  migration that has been applied: add a new one. (Entries 0 and 1
  share a `when`, from the live Space, which is fine for them only.)
- `space.json`: the Space's manifest, written by Muse's builder.

A label is up to 128 letters, digits, dots, dashes and underscores,
and starts with a letter or digit: the store's rule, which the console
checks before calling the store, after trimming spaces at either end.

## The history is the console's, not the bucket's

The store can't list its bucket: its Lambda role has no list
permission, by design. So the console keeps its own record of every
fetch, store and delete that succeeds (label, action, size and time),
and shows the labels it knows from that record. A fetch that finds
nothing, or a call that fails, isn't recorded. The page shows the
newest 100 operations: a label whose last operation is older than
that drops out of the list on the page, though its rows stay in the
database.

When your agent stores, fetches or deletes a blob through its own
connection, the console doesn't see it. `registerExternalOperation` lets the agent
add that operation to the same record, so the console's view stays
complete. It writes only to the console's own database and never
contacts the store.

## Security, honestly

The console keeps the store's bearer token in its own server-side
database, so you can use it without pasting the token on every visit.
That is weaker than the agent's own path to the store, where the token
sits in Muse's credential store and is added to each request on its
way out. The console is meant for a store that holds only ciphertext,
which is all an s3-blob-store should ever hold. Never put a plaintext
secret in it: anything you store goes to S3 as typed.

[SETUP.md](SETUP.md) explains how the token is stored and how to check
that your browser never receives it.

## Acknowledgements

Designed and maintained by a human.

Built with AI collaborators:

- **Muse**, Meta's personal AI agent, built the console as a Muse
  Space and verified it live against a deployed store.
- **Claude** (Anthropic), as Claude Code, built the repo's CI and
  change workflow and drafted these docs from Muse's notes.

The console is a client for the
[s3-blob-store](https://github.com/cmeans/s3-blob-store) API, built
on Muse's Spaces platform.

## License

MIT. See [LICENSE](LICENSE).
