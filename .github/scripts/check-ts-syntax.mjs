// Parse every TypeScript and JavaScript source file and report syntax errors.
//
// CI can't install this repo's dependencies: the Muse Space SDK
// (@hatch/space-sdk) is a local file dependency that exists only inside a
// Muse Space, so a full typecheck (`bun run typecheck`) runs there, not here.
// This is the check CI can make without it: each file must parse, with the
// TypeScript version package.json pins. Only parser errors are reported:
// grammar errors TypeScript finds in its checker need the full typecheck.
//
// Usage: node check-ts-syntax.mjs <file>...
// Needs the typescript package resolvable (NODE_PATH or a local install).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
// TypeScript 7 ships without the JS API this script uses.
if (typeof ts.createProgram !== "function") {
  console.error(
    `typescript ${ts.version}: no JS API (TypeScript 7+); this check needs TypeScript 5.x or 6.x`,
  );
  process.exit(2);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("no files given");
  process.exit(2);
}

// Syntax only: no imports followed, no lib, so nothing outside the given
// files is needed. Declaration files (.d.ts) are parsed too.
const program = ts.createProgram(files, {
  noResolve: true,
  noLib: true,
  noEmit: true,
  allowJs: true,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
});

let failed = 0;
for (const file of files) {
  const sf = program.getSourceFile(file);
  if (!sf) {
    console.log(`${file}: not read`);
    failed++;
    continue;
  }
  for (const d of program.getSyntacticDiagnostics(sf)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      console.log(`${file}:${line + 1}:${character + 1}: ${msg}`);
    } else {
      console.log(`${file}: ${msg}`);
    }
    failed++;
  }
}

console.log(`typescript ${ts.version}: ${files.length} files, ${failed} errors`);
process.exit(failed ? 1 : 0);
