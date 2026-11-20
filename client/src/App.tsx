import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api } from "./api";

const FIELDS = actionFields<typeof Actions>();

type TestStatus =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "unreachable"
  | "not_configured"
  | "error";

function testTone(status: TestStatus): string {
  if (status === "ok") return "text-[var(--accent)]";
  if (status === "unauthorized" || status === "forbidden" || status === "error") {
    return "text-[var(--danger)]";
  }
  return "text-[var(--dim)]";
}

export function App() {
  const queryClient = useQueryClient();

  const configState = useQuery({
    queryKey: ["configState"],
    queryFn: () => api.getConfigState({}),
  });
  const configured = configState.data?.configured ?? false;
  const savedUrl = configState.data?.functionUrl ?? null;

  // --- Setup form state ---
  const [editing, setEditing] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    status: TestStatus;
    message: string;
  } | null>(null);

  // Show the form when nothing is configured, or when the operator chose Edit.
  const showForm = !configured || editing;

  useEffect(() => {
    if (editing && savedUrl) setUrlInput(savedUrl);
  }, [editing, savedUrl]);

  const saveConfig = useMutation({
    mutationFn: async (input: { functionUrl: string; token: string }) =>
      await api.saveConfig(input),
    onError: (error) => setSetupError(error.message),
  });

  const testConnection = useMutation({
    mutationFn: async () => await api.testConnection({}),
    onSuccess: (result) =>
      setTestResult({ status: result.status, message: result.message }),
    onError: (error) =>
      setTestResult({ status: "error", message: error.message }),
  });

  async function handleSave() {
    setSetupError(null);
    if (!urlInput.trim()) {
      setSetupError("Enter the Function URL.");
      return;
    }
    if (!tokenInput.trim()) {
      setSetupError("Enter the bearer token.");
      return;
    }
    try {
      await saveConfig.mutateAsync({
        functionUrl: urlInput.trim(),
        token: tokenInput.trim(),
      });
      setTokenInput("");
      setEditing(false);
      setTestResult(null);
      await queryClient.invalidateQueries({ queryKey: ["configState"] });
    } catch {
      // onError already surfaced the message.
    }
  }

  async function handleTest() {
    setTestResult(null);
    // If the form holds unsaved values, save them first so the test runs
    // against what the operator actually typed.
    if (showForm && (urlInput.trim() || tokenInput.trim())) {
      if (!urlInput.trim() || !tokenInput.trim()) {
        setSetupError("Enter both the Function URL and the token, then test.");
        return;
      }
      try {
        await saveConfig.mutateAsync({
          functionUrl: urlInput.trim(),
          token: tokenInput.trim(),
        });
        setTokenInput("");
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: ["configState"] });
      } catch (error) {
        setTestResult({
          status: "error",
          message: error instanceof Error ? error.message : "Save failed.",
        });
        return;
      }
    }
    testConnection.mutate();
  }

  // --- Blob state ---
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  const [blobStatus, setBlobStatus] = useState<string | null>(null);
  const [blobStatusError, setBlobStatusError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function reportBlob(message: string, isError: boolean) {
    setBlobStatus(message);
    setBlobStatusError(isError);
  }

  const fetchBlob = useMutation({
    mutationFn: async (lbl: string) => await api.fetchBlob({ label: lbl }),
    onSuccess: (result) => {
      if (result.found && result.content != null) {
        setContent(result.content);
      }
      reportBlob(result.message, !result.found && result.status !== 404);
    },
    onError: (error) => reportBlob(error.message, true),
  });

  const storeBlob = useMutation({
    mutationFn: async (input: { label: string; content: string }) =>
      await api.storeBlob(input),
    onSuccess: (result) => reportBlob(result.message, !result.ok),
    onError: (error) => reportBlob(error.message, true),
  });

  const deleteBlob = useMutation({
    mutationFn: async (lbl: string) => await api.deleteBlob({ label: lbl }),
    onSuccess: (result) => {
      reportBlob(result.message, !result.ok);
      if (result.ok) setContent("");
    },
    onError: (error) => reportBlob(error.message, true),
  });

  function requireLabel(): string | null {
    const lbl = label.trim();
    if (!lbl) {
      reportBlob("Enter a label first.", true);
      return null;
    }
    return lbl;
  }

  function handleFetch() {
    const lbl = requireLabel();
    if (lbl) fetchBlob.mutate(lbl);
  }

  function handleStore() {
    const lbl = requireLabel();
    if (lbl) storeBlob.mutate({ label: lbl, content });
  }

  function handleDelete() {
    const lbl = requireLabel();
    if (!lbl) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      reportBlob(
        `Delete "${lbl}" permanently? The store has versioning off — this cannot be undone.`,
        false,
      );
      return;
    }
    setConfirmingDelete(false);
    deleteBlob.mutate(lbl);
  }

  const busy =
    fetchBlob.isPending || storeBlob.isPending || deleteBlob.isPending;

  // --- History (this console's own record) ---
  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => api.listHistory({ limit: 100 }),
  });
  const historyEntries = history.data?.entries ?? [];
  // Latest record per label, most recent first — the labels this console
  // knows about and what last happened to each.
  const knownLabels: typeof historyEntries = [];
  {
    const seen = new Set<string>();
    for (const entry of historyEntries) {
      if (!seen.has(entry.label)) {
        seen.add(entry.label);
        knownLabels.push(entry);
      }
    }
  }

  function fillLabel(lbl: string) {
    setLabel(lbl);
    setConfirmingDelete(false);
    document
      .getElementById("blob-label")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] font-sans text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        {/* Safety line — always visible */}
        <p className="border-b border-[var(--border)] py-2 text-center font-mono text-sm font-semibold tracking-tight">
          Ciphertext only — never the plaintext secret.
        </p>

        {/* Setup */}
        <section aria-label="Store setup" className="mt-4">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
            Setup
          </h2>

          {configState.isPending ? (
            <p className="mt-3 text-sm text-[var(--dim)]">Loading…</p>
          ) : showForm ? (
            <div className="mt-3 space-y-3">
              <div>
                <label
                  htmlFor="function-url"
                  className="text-sm font-medium"
                >
                  Function URL
                </label>
                <input
                  id="function-url"
                  {...FIELDS.saveConfig.functionUrl}
                  type="url"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://…lambda-url.…on.aws/"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label htmlFor="store-token" className="text-sm font-medium">
                  Bearer token
                </label>
                <input
                  id="store-token"
                  {...FIELDS.saveConfig.token}
                  type="password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    configured
                      ? "Saved — enter a new token to replace it"
                      : "Token"
                  }
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm"
                />
                <p className="mt-1 text-xs text-[var(--dim)]">
                  Stored server-side only. It is never shown again after
                  saving.
                </p>
              </div>

              {setupError && (
                <p role="alert" className="text-sm text-[var(--danger)]">
                  {setupError}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveConfig.isPending}
                  className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {saveConfig.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testConnection.isPending || saveConfig.isPending}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {testConnection.isPending
                    ? "Testing…"
                    : "Test connection"}
                </button>
                {configured && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setSetupError(null);
                      setTokenInput("");
                    }}
                    className="rounded-[var(--radius)] px-3 py-2 text-sm text-[var(--dim)]"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="min-w-0 flex-1 truncate font-mono text-sm">
                {savedUrl}
              </p>
              <span className="text-sm text-[var(--dim)]">
                Token: saved
              </span>
              <button
                type="button"
                onClick={handleTest}
                disabled={testConnection.isPending}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {testConnection.isPending ? "Testing…" : "Test connection"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-[var(--radius)] px-3 py-2 text-sm font-medium text-[var(--accent)]"
              >
                Edit
              </button>
            </div>
          )}

          {testResult && (
            <p
              role="status"
              className={`mt-3 font-mono text-sm ${testTone(testResult.status)}`}
            >
              {testResult.message}
            </p>
          )}
        </section>

        {/* Blobs */}
        <section aria-label="Blob operations" className="mt-6">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
            Blob
          </h2>
          <p className="mt-2 text-sm text-[var(--dim)]">
            The store cannot list labels — work by exact label.
          </p>

          <div className="mt-3">
            <label htmlFor="blob-label" className="text-sm font-medium">
              Label
            </label>
            <input
              id="blob-label"
              {...FIELDS.fetchBlob.label}
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. handoff-2026-11-20"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setConfirmingDelete(false);
              }}
              className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm"
            />
          </div>

          <div className="mt-3">
            <label htmlFor="blob-content" className="text-sm font-medium">
              Ciphertext
            </label>
            <textarea
              id="blob-content"
              {...FIELDS.storeBlob.content}
              aria-label="Ciphertext content"
              rows={6}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Fetch fills this in, or paste ciphertext here and Store it."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm leading-relaxed"
            />
            <p className="mt-1 text-right font-mono text-xs text-[var(--dim)]">
              {content.length} characters
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleFetch}
              disabled={!configured || busy}
              className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {fetchBlob.isPending ? "Fetching…" : "Fetch"}
            </button>
            <button
              type="button"
              onClick={handleStore}
              disabled={!configured || busy}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {storeBlob.isPending ? "Storing…" : "Store"}
            </button>
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={!configured || busy}
                  className="rounded-[var(--radius)] bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {deleteBlob.isPending
                    ? "Deleting…"
                    : "Confirm delete — irreversible"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-[var(--radius)] px-3 py-2 text-sm text-[var(--dim)]"
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleDelete}
                disabled={!configured || busy}
                className="rounded-[var(--radius)] px-4 py-2 text-sm font-medium text-[var(--danger)] disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>

          {!configured && !configState.isPending && (
            <p className="mt-3 text-sm text-[var(--dim)]">
              Configure the store above before fetching or storing blobs.
            </p>
          )}

          {blobStatus && (
            <p
              role="status"
              className={`mt-3 font-mono text-sm ${
                blobStatusError ? "text-[var(--danger)]" : "text-[var(--text)]"
              }`}
            >
              {blobStatus}
            </p>
          )}
        </section>

        {/* History — this console's own record */}
        <section id="history" aria-label="History" className="mt-6">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
            History
          </h2>
          <p className="mt-2 text-sm text-[var(--dim)]">
            This console's record of its own operations — the store cannot
            list the bucket.
          </p>

          {history.isPending ? (
            <p className="mt-3 text-sm text-[var(--dim)]">Loading…</p>
          ) : history.isError ? (
            <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
              History could not be loaded — reload the page to try again.
            </p>
          ) : historyEntries.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              No operations recorded yet. Fetch, store or delete a blob and
              it will appear here.
            </p>
          ) : (
            <>
              <h3 className="mt-4 text-sm font-medium">Known labels</h3>
              <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto pr-1">
                {knownLabels.map((entry) => (
                  <li key={entry.label}>
                    <button
                      type="button"
                      onClick={() => fillLabel(entry.label)}
                      aria-label={`Use label ${entry.label}`}
                      className="flex w-full flex-wrap items-baseline gap-x-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left"
                    >
                      <span className="font-mono text-sm font-medium">
                        {entry.label}
                      </span>
                      <span
                        className={`font-mono text-xs ${
                          entry.action === "deleted"
                            ? "text-[var(--danger)]"
                            : "text-[var(--accent)]"
                        }`}
                      >
                        last: {entry.action}
                        {entry.size != null ? ` · ${entry.size} chars` : ""}
                      </span>
                      <span className="ml-auto font-mono text-xs text-[var(--dim)]">
                        {formatTime(entry.created_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <h3 className="mt-5 text-sm font-medium">All operations</h3>
              <ul className="mt-2 max-h-72 divide-y divide-[var(--border)] overflow-y-auto border-y border-[var(--border)]">
                {historyEntries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline gap-x-3 px-1 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => fillLabel(entry.label)}
                      aria-label={`Use label ${entry.label}`}
                      className="font-mono text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      {entry.label}
                    </button>
                    <span className="font-mono text-xs">
                      {entry.action}
                      {entry.size != null ? ` · ${entry.size} chars` : ""}
                    </span>
                    <span className="ml-auto font-mono text-xs text-[var(--dim)]">
                      {formatTime(entry.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
