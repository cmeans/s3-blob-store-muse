// Check that every console message the docs quote exists in the code.
//
// README.md, SETUP.md and SKILL.md quote the console's messages in inline
// code (`Connected — the store answered ok and accepted the token.`). This
// script finds each quote that reads as a message, and requires it to match
// a string the code can produce.
//
// - A doc quote counts as a message when it starts with a capital letter,
//   contains a space and ends with a period: the shape of every message the
//   console shows. Names, paths, values and code (`fetchBlob`, `found: false`,
//   `Authorization: Bearer`) don't, and aren't checked.
// - The code's strings are the string literals, template literals and JSX
//   text in the given source files, parsed with TypeScript. In a template,
//   each `${...}` matches any text without a `"`, so a doc can quote a message with a
//   value filled in (`Stored 15 characters under "setup-check".`) or with a
//   placeholder (`Fetched … characters.`). JSX text is joined across its
//   {expressions}, which match the same way, and its whitespace collapsed, as a
//   browser shows it.
// - A quote must match one string in full. Inline code in fenced code blocks
//   isn't read.
//
// Usage: node check-doc-quotes.mjs --docs <doc.md>... --src <file>...
// Needs the typescript package resolvable (NODE_PATH or a local install).
// Exit 0 when every quote matches, 1 when one doesn't, 2 on a usage error.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
if (typeof ts.createSourceFile !== "function") {
  console.error(
    `typescript ${ts.version}: no JS API (TypeScript 7+); this check needs TypeScript 5.x or 6.x`,
  );
  process.exit(2);
}

// Escape for a ::error workflow command, as GitHub's own toolkit does.
const escData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function parseArgs(argv) {
  const out = { docs: [], src: [] };
  let into = null;
  for (const a of argv) {
    if (a === "--docs") into = out.docs;
    else if (a === "--src") into = out.src;
    else if (into) into.push(a);
    else {
      console.error(`unexpected argument before --docs or --src: ${a}`);
      process.exit(2);
    }
  }
  if (out.docs.length === 0 || out.src.length === 0) {
    console.error("usage: node check-doc-quotes.mjs --docs <doc.md>... --src <file>...");
    process.exit(2);
  }
  return out;
}

const ANY = "\u0000"; // stands for a ${...} or {expression}; can't occur in text
const BREAK = "\u0001"; // where a child element splits a JSX element's text

// Turn a string with ANY markers into a regex that must match a quote in full.
function toRegex(s) {
  const parts = s.split(ANY).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A placeholder matches any text without a double quote, so a quote that
  // shows the code's own quotes around a value fails if the code drops them.
  return new RegExp(`^${parts.join('[^"]+')}$`, "s");
}

function codeStrings(files) {
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      console.log(`::error file=${escProp(file)}::${escData(`${file}: can't read it (${e.code ?? e.message})`)}`);
      process.exitCode = 1;
      continue;
    }
    const kind = /\.[cm]?[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        found.push(node.text);
      } else if (ts.isTemplateExpression(node)) {
        found.push(node.head.text + node.templateSpans.map((s) => ANY + s.literal.text).join(""));
      } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        // An element's text children, joined across {expressions}.
        let joined = "";
        for (const c of node.children) {
          if (ts.isJsxText(c)) joined += c.text;
          else if (ts.isJsxExpression(c) && c.expression) joined += ANY;
          else joined += BREAK; // a child element breaks the text
        }
        for (const piece of joined.split(BREAK)) {
          const t = piece.replace(/\s+/g, " ").trim();
          if (t) found.push(t);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

// Inline code spans outside fenced code blocks, with their line numbers.
function docQuotes(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const quotes = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    for (const m of line.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) quotes.push({ text: m[1], line: i + 1 });
  });
  return quotes;
}

const isMessage = (q) => /^\p{Lu}/u.test(q) && q.includes(" ") && q.endsWith(".");

const { docs, src } = parseArgs(process.argv.slice(2));
const patterns = codeStrings(src)
  .filter((s) => /\p{L}{3}/u.test(s.split(ANY).join(""))) // some text of its own
  .map(toRegex);

let checked = 0;
let missing = 0;
for (const doc of docs) {
  let quotes;
  try {
    quotes = docQuotes(doc);
  } catch (e) {
    console.log(`::error file=${escProp(doc)}::${escData(`${doc}: can't read it (${e.code ?? e.message})`)}`);
    process.exitCode = 1;
    continue;
  }
  for (const q of quotes.filter((q) => isMessage(q.text))) {
    checked++;
    if (!patterns.some((re) => re.test(q.text))) {
      missing++;
      const msg = `${doc}:${q.line}: no string in the code matches this quote: ${q.text}`;
      console.log(`::error file=${escProp(doc)},line=${q.line}::${escData(msg)}`);
    }
  }
}

console.log(`${docs.length} docs, ${src.length} source files: ${checked} quoted messages, ${missing} not in the code`);
if (missing) process.exitCode = 1;
