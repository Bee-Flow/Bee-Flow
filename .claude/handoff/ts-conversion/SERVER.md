# Handoff: JSDoc types for the server, by tooling

The agent-hub conversion (see README.md here) taught the tooling where types come from.
This applies the same inference to `server/`, which stays JavaScript and CommonJS: no
rename, no build step, types as JSDoc, a file checked once it carries `// @typecheck`
(`server/jsconfig.json`, `cd server && npm run typecheck`, `npm run lint:checkjs-ratchet`).

**Not run yet.** The scripts and their unit tests are in; the first real run is the next step.

## Why not the agent-hub converter

`scripts/ts-convert-codefix.mjs` renames to `.ts`/`.tsx` and writes TypeScript syntax. On the
server that would turn `module.exports` into `export` across hundreds of files, and the repo
decided against a server build step. So the server gets the same inference, lowered to JSDoc.

## What runs, and what it writes

`scripts/jsdoc-convert-server.mjs` (driver):

1. A language service over `server/jsconfig.json` with `checkJs` and `noImplicitAny` on for the
   run: its implicit-any diagnostics say where a type is missing.
2. `scripts/ts-callsite-types.mjs` infers per function and value, the same sources as agent-hub:
   typed call sites (JavaScript callers count here; tests never do), what a value is handed to,
   how a callback is called, values observed while the tests ran (`--observed`), lookup tables,
   caught errors, objects grown after their literal, options objects (`fn({ a } = {})`).
   CommonJS: `findReferences` does not follow `module.exports = { fn }` into
   `const { fn } = require('./x')`; `cjsImporterRefs` does (also `m.fn(...)` and
   `module.exports = fn`), resolved by the checker, not by file name.
3. `scripts/jsdoc-lower.mjs` writes the result as JSDoc:
   - `@param {T} x` (optional `[x]`), merged into an existing block without duplicating a name
   - `@typedef {Object} P` + `@property` for a props/options object, above the function's own JSDoc
   - `/** @type {T} */` above a variable, `/** @type {Error} */ (e)` for a caught error
   - `/** @typedef {import('./x').T} T */` at the top for a type from another module
4. TypeScript's own "infer from usage" quick fix (in a `.js` file it writes JSDoc), refused when
   it would write `any`.
5. Self-check, as in agent-hub: a slot typed from a demand, a callback shape or an observation
   whose own references now error had the wrong source; it is banned and the run is redone.
6. `--mark`: a file with no error under the server's own jsconfig gets `// @typecheck`.

Only comments and a JSDoc cast's parentheses are added: the compiled program is unchanged.
`--check` proves it per file (HEAD vs working tree, compiled with esbuild).

Forbidden in what it writes: `{any}`, `{*}`, `{?}`, `{Function}`, ts-comments.

## Runtime observation (optional, worth it)

```
node scripts/ts-runtime-types.mjs collect-server --batch list.txt --out obs-server.json
```

A `--require` hook instruments the listed files in memory while each server test file runs in its
own `node --test` process (as `server/scripts/run-tests.mjs` does), and records what parameters,
props and state hold. Tests that need Postgres fail fast without one; they still record what ran.

## The loop (one folder at a time keeps memory and review small)

```
# 1. pick a folder
git ls-files 'server/core/llm/*.js' | grep -v '\.test\.js$' > /tmp/list.txt
# 2. optional: observe types while its tests run
node scripts/ts-runtime-types.mjs collect-server --batch /tmp/list.txt --out /tmp/obs.json
# 3. look first (writes nothing in the tree)
node scripts/jsdoc-convert-server.mjs --batch /tmp/list.txt --observed /tmp/obs.json --out /tmp/jsdoc-out > /tmp/run.json
# 4. apply and mark
node scripts/jsdoc-convert-server.mjs --batch /tmp/list.txt --observed /tmp/obs.json --write --mark > /tmp/run.json
# 5. prove and check
node scripts/jsdoc-convert-server.mjs --batch /tmp/list.txt --check      # 0 different
cd server && npm run typecheck && cd ..
node scripts/checkjs-ratchet.mjs server --update                         # raise the floor
npm run check:fast
cd server && node --test <the tests next to the changed files>
```

`run.json` has per file: `changed`, `errorsUnderNoImplicitAny` (what is still untyped),
`cleanUnderServerConfig`, `marked`, and the inference report (which slot came from which source,
which stayed open and why).

## Lessons from agent-hub that apply here

- The biggest root of open types is data from outside (HTTP bodies, DB rows): nothing in the code
  says their shape. Observed values and existing typedefs (`server/types/`) are the sources.
- A demand (what a value is handed to) is only a lower bound: the self-check bans it when the
  value is then used beyond it. A named type counts from that side, an anonymous shape does not.
- Files that import each other belong in one run: types flow along the imports.
- Never `any`, never a cast that silences a real mismatch; leave the slot open instead.
- The server's strictness rises option by option (`server/jsconfig.json`): once a folder is clean
  under `noImplicitAny`, that is the next option to turn on for it.

## Untested ground

- `fixMissingMember` is not used on the server (in a `.js` file it would add code); class fields
  get no JSDoc yet.
- Memory: the driver has no chunking yet (agent-hub's converter does); run per folder.
- `cjsImporterRefs` reads the `require('...')` forms above; `exports` reassigned through a
  variable or built in a loop is not followed (those functions stay untyped by call sites).
