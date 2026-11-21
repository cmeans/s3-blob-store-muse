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
//   each `${...}` matches one value: a token with no whitespace and no `"`,
//   or, between the code's own double quotes, any text without a `"`. So a
//   doc can quote a message with a value filled in (`Stored 15 characters
//   under "setup-check".`) or with a placeholder (`Fetched … characters.`),
//   but not with a word the code dropped. JSX text is joined across its
//   {expressions}, which match the same way (a string literal such as {" "}
//   is text). Its whitespace is first trimmed as JSX does (whitespace that
//   contains a line break, at the start or end of a text run, is dropped),
//   its HTML entities decoded, and then collapsed, as a browser shows it.
// - A quote must match one string in full.
// - Code spans are read close to CommonMark: a run of any number of
//   backticks opens one (not after a backslash), and a span can continue
//   across the lines of a paragraph (each line break reads as a space). A
//   blank line, a list item, a heading or a table row starts a new block.
// - Not read: inline code in fenced code blocks, and HTML (<code>). A fence
//   is recognized only with at most 3 spaces of indentation and outside a
//   blockquote; inline code in a fence indented further (in a list item) or
//   in a blockquote is read as prose. A list item's lazy continuation, an
//   escaped backslash before a backtick, and other rare forms may be read
//   differently from GitHub. The docs have none of these today.
//
// Usage: node check-doc-quotes.mjs --docs <doc.md>... --src <file>...
// Needs the typescript package resolvable (NODE_PATH or a local install).
// Exit 0 when every quote matches, 1 when one doesn't or a file can't be
// read, 2 on a usage error or when TypeScript isn't installed.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch (e) {
  console.error(
    `can't load typescript (${e.code ?? e.message}): install it, e.g. ` +
      "npm install --prefix <dir> --no-save typescript@<version in package.json>, " +
      "and run with NODE_PATH=<dir>/node_modules",
  );
  process.exit(2);
}
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
  // Adjacent placeholders (`${a}${b}`, `{a}{b}`) are one value: as separate
  // groups they'd backtrack exponentially on a long quote that doesn't match.
  const raw = s.replace(new RegExp(`${ANY}+`, "g"), ANY).split(ANY);
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A placeholder matches one value, never a run of words, so a word dropped
  // from the code next to a ${...} is caught. A value is one token: no
  // whitespace and no double quote. Between the code's own double quotes
  // (`under "${label}"`) it is anything without a double quote, so a doc can
  // show a label with spaces (`"<your label>"`). Either way a quote that
  // shows the code's quotes around a value fails if the code drops them.
  let out = esc(raw[0]);
  for (let i = 1; i < raw.length; i++) {
    const quoted = raw[i - 1].endsWith('"') && raw[i].startsWith('"');
    out += (quoted ? '[^"]+' : '[^"\\s]+') + esc(raw[i]);
  }
  return new RegExp(`^${out}$`, "s");
}

// The HTML entities JSX text decodes, for the ones a message might use.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decodeEntities = (t) =>
  t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// JSX text as React renders it: lines are trimmed where they meet a line
// break, whitespace-only lines dropped, and the rest joined with a space
// (the rule TypeScript's and Babel's JSX transforms apply).
function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  const kept = [];
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, " ");
    if (i > 0) t = t.replace(/^ +/, "");
    if (i < lines.length - 1) t = t.replace(/ +$/, "");
    if (t) kept.push(t);
  });
  return kept.join(" ");
}

// The code's strings, or null when a source file can't be read (then the
// quotes aren't checked: every miss would be a false one).
function codeStrings(files) {
  const found = [];
  let unreadable = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      console.log(`::error file=${escProp(file)}::${escData(`${file}: can't read it (${e.code ?? e.message})`)}`);
      unreadable++;
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
          if (ts.isJsxText(c)) joined += decodeEntities(jsxText(c.text));
          else if (
            ts.isJsxExpression(c) &&
            c.expression &&
            (ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression))
          )
            joined += c.expression.text; // {" "} and the like are text
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
  return unreadable ? null : found;
}

// A code span: a backtick run, then text up to a run of the same length
// (CommonMark's rule; the text can't start or end inside a longer run). A
// backslash before the opening run escapes it.
const CODE_SPAN = /(?<![`\\])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])(\s|$)/;

// Inline code spans outside fenced code blocks, with the line each starts on.
function docQuotes(file) {
  const lines = readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  const quotes = [];
  let fence = null;
  let para = []; // [{ text, line }] of the paragraph being read
  const flush = () => {
    if (para.length === 0) return;
    // Join the lines with "\n", remembering where each starts.
    let joined = "";
    const starts = [];
    for (const p of para) {
      if (joined) joined += "\n";
      starts.push([joined.length, p.line]);
      joined += p.text;
    }
    for (const m of joined.matchAll(CODE_SPAN)) {
      let text = m[2].replace(/\n/g, " ");
      // CommonMark strips one space from each end when both are there.
      if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
      const line = starts.filter(([at]) => at <= m.index).at(-1)[1];
      quotes.push({ text, line });
    }
    para = [];
  };
  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      flush();
      if (fence === null) fence = f[1];
      // A closing fence has nothing after its run (no info string).
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim())
        fence = null;
      return;
    }
    if (fence !== null) return;
    if (!line.trim()) {
      flush(); // a blank line ends the paragraph
    } else if (LIST_ITEM.test(line)) {
      flush(); // a new list item starts a new paragraph
      para.push({ text: line, line: i + 1 });
    } else if (/^ {0,3}(#|\|)/.test(line)) {
      // A heading or a table row is a block of its own line.
      flush();
      para.push({ text: line, line: i + 1 });
      flush();
    } else {
      para.push({ text: para.length ? line.replace(/^\s+/, "") : line, line: i + 1 });
    }
  });
  flush();
  return quotes;
}

const isMessage = (q) => /^\p{Lu}/u.test(q) && q.includes(" ") && q.endsWith(".");

const { docs, src } = parseArgs(process.argv.slice(2));
const strings = codeStrings(src);
if (strings === null) {
  console.log("A source file couldn't be read, so the docs' quotes weren't checked.");
  process.exit(1);
}
const patterns = strings
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
