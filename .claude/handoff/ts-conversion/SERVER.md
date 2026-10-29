# Handoff: JSDoc types for the server, by tooling

The agent-hub conversion (see README.md here) taught the tooling where types come from.
This applies the same inference to `server/`, which stays JavaScript and CommonJS: no
rename, no build step, types as JSDoc, a file checked once it carries `// @typecheck`
(`server/jsconfig.json`, `cd server && npm run typecheck`, `npm run lint:checkjs-ratchet`).

**Run on 2026-10-28** over every server directory, as `scripts/jsdoc-round.sh` (the loop below with
every gate scripted): 431 files typed in 49 batches on four machines, floors 3644 / 2302 / 1929 to
3668 / 2329 / 1954, no compiled line changed. What the first batches taught, now in the tooling:

- an options typedef is written only when every destructured member is typed; a partial one
  breaks the file at base level (TS2339) and typecheck-settle then reverts the whole file;
- in a JS file, positional `@param` tags go in for all parameters without a default or for none:
  one tag turns the undocumented parameters from optional into required for every caller;
- the tests next to the batch are in the program (not as a source of types): a test calling a
  store with fewer arguments or a wider value is where a wrong type shows first, and a caller's
  TS2345/TS2554 maps to the callee's slot (`calleeSlotOfDiagnostic`) and bans every source of it;
- TypeScript's inferFromUsage may not add a `require` for a type, nor write a `@param` for a
  slot a caller contradicted (`quickFixRefuser`);
- typedefs are written as `@typedef {{ a?: T }} Name` (the inline form the server uses; `{Object}`
  counts against the loose-type ratchet), and the equivalence gate strips JSDoc casts before
  compiling, because esbuild keeps them and lays the call out differently.

Yield per batch of 40: 5 to 22 files kept; what goes back is a file whose new type a caller
contradicts in a way the bans cannot repair (an `instanceof` on a narrowed catch variable, a
spread into a parameter list), or one the added lines push over its line ceiling.

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

`run.json` has per file: `changed`, `errorsUnderNoImplicitAny` (what is still untyped), the
`errors` themselves (code, line, message), `errorsBefore`, `cleanUnderServerConfig`, `marked`, and
the inference report (which slot came from which source, which stayed open and why); at the top
`byCodeBefore` / `byCode` sum the errors over the run by TS code, measured under the server's
jsconfig plus `noImplicitAny` only, so two runs compare. The inference itself runs with
`strictNullChecks` on (`--no-strict-null` turns it off): a caller's `string|null` and a literal
null argument then reach the JSDoc as `string | null`, right for the day the server turns that
option on. Measured on 58 files across core/llm, core/http, stores, routes and core/documents
(2026-10-22): 340 errors before the run, 248 after, run time 38 s; the first version of the
driver left 297 and took 220 s (it re-typed every slot on every pass, see the header of
`scripts/jsdoc-lower.mjs`). Biggest classes left: TS7006 (145: parameters with no typed caller,
mostly `req`/`res`/`next` and data from the database), TS2339 (48: members read on a
hand-written `{Object}`), TS7053 (13: lookup tables).

After a `--write` round, `node scripts/ts-behaviour-diff.mjs --base HEAD --paths server` must
report 0 different compiled programs (JSDoc is comments only); it also covers the files an agent
touched afterwards, which `--check` does not.

## The loose-type round (2026-10-28, agents)

After the tooling round, the `{Object}`, `{object}`, `{any}`, `{*}` and `{Function}` tags were
named by hand, one Opus agent per area in its own worktree (`wt/loose-*`), comments only (the
behaviour diff against the base is the gate before every commit, with typecheck, the tests next to
each file and `check:fast`). The `jsdoc-loose-type` ratchet went from 2227 to 929 for the whole
server: routes 355 to 48, automation 255 to 47, stores 247 to 83, core 750 to 174.

What an agent can name from the code alone: an options bag with sub-tags (becomes the literal
shape, the sub-tag descriptions move into the sentence), a callback (its real signature), a row
(the store's own typedef or `import('../types/rows').DbRow.X`), a JSON body (`Record<string,
unknown>`), a value only narrowed later (`unknown`). What stays loose, and why:

- defensive inputs narrowed field by field (DLP shields, automation steps, deck inputs): `unknown`
  does not compile there without code changes, and the stored shapes are untyped DSL JSON;
- the shared `ctx` built in `core/index.js` and the collab rows: typing them ripples through every
  lifecycle file;
- casts around SDK enums (google, mistral) and library internals (JSZip, dns lookup);
- lazy-require spreads typed `{Function}` whose callers read the result untyped;
- self-mutating `result`/`state` objects and `any` returns from optional `require`s.

Merging two such branches: both change comments only, so `git merge -X theirs` is safe; what to
check afterwards is a typedef defined twice in one file, a helper one branch typed narrower than
a caller the other branch typed (`assertRecordId`), a comment reflow that puts a history phrase
on one line (`history-comments` ratchet), and the per-file line ceilings.

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
