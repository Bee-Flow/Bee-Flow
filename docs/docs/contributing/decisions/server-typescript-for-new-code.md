---
title: "0026: New server code is TypeScript that Node runs as written"
description: Why a new server file is a .mts file with no build step, why the existing files stay CommonJS JavaScript with JSDoc types, and how the two module systems load each other in a way the architecture gates can read.
---

# 0026: New server code is TypeScript that Node runs as written

**Status:** accepted, in effect. **Supersedes:** [0001](./server-javascript-jsdoc.md). **Code:**
`server/scripts/typecheck.mjs` (the four levels and `MTS_OPTIONS`), `server/eslint.config.js` (the
`**/*.mts` block). **Enforced by:** `scripts/check-new-code-types.mjs` (in `npm run check:fast` as
`new-code-types`, and in `ci.yml`), `npm run lint:checkjs-ratchet`, `scripts/mts-coverage.mjs`,
`server/layering.test.js` and `scripts/scc-ratchet.mjs`.

## Context

Record 0001 kept the server in JavaScript because TypeScript meant a build step: a second copy of
the server, `module.exports` rewritten across hundreds of files, and tests that no longer run on
the source. That reason does not hold for a `.mts` file. The Node version the server runs on
(`.nvmrc`) strips the types when it loads the file, so a `.mts` file runs from its source like a
`.js` file does.

The code moved before the record did. The server holds about 500 `.mts` files next to its
JavaScript (the `mts` level that `cd server && npm run typecheck` reports), and the check on new
files tells an author to write `.mts`. Record 0001 still said that the server stays JavaScript and
that a new file starts at `// @typecheck strict`.

## Decision

- **A new server source file is TypeScript, or strict JavaScript.** A file added since the merge
  base with `origin/main` is a `.mts` (or `.cts`) file, or a `.js` file with `// @typecheck strict`
  in its header. `scripts/check-new-code-types.mjs` fails otherwise. Tests and their kits,
  declaration files, migrations, the i18n dictionaries, generated files and fixtures are exempt.
- **A `.mts` file runs as it is written.** There is no build step and no compiled copy. It needs no
  marker: `server/scripts/typecheck.mjs` always checks it at its own level, `mts`, which is strict
  plus `erasableSyntaxOnly`. Syntax that needs a transform (enums, namespaces, parameter
  properties) is therefore a type error. ESLint lints the text Node executes
  (`server/eslint.config.js`).
- **The existing files stay CommonJS JavaScript with JSDoc types.** That part of record 0001
  stands: a file opts in with `// @typecheck`, `// @typecheck noImplicitAny` or
  `// @typecheck strict`, an old file moves up one level at a time, and the number of files at each
  level may only rise (`npm run lint:checkjs-ratchet`). A `.mts` file counts at all three levels,
  so renaming one back to `.js` without a marker fails the floors. The JSDoc types of the old files
  come from tooling first (`scripts/jsdoc-round.sh`, `scripts/jsdoc-convert-server.mjs`).
- **The two module systems load each other in one spelled-out way.** A `.mts` file is an ES
  module. It imports another `.mts` file with `import … from './x.mts'`, and it loads CommonJS
  through `createRequire(import.meta.url)`, kept under the name `nodeRequire` or called directly. A
  CommonJS file loads a `.mts` file with a plain `require('./x.mts')`. The `.mts` extension is
  always written out. `server/appStudio/stepBudget.mts` shows the first two forms and
  `server/routes/studioAppsRun.js` the third.
- **The architecture gates read that call.** `server/layering.test.js` (upward and
  feature-to-feature requires) and `scripts/scc-ratchet.mjs` (import cycles) scan `.mts` files and
  count `nodeRequire('./x')` and `createRequire(import.meta.url)('./x')` as requires. A
  `createRequire` kept under any other name is not read, so it is named `nodeRequire`.
- **Tests do not change.** A test is `x.test.js` next to the source, loads `./x.mts` with
  `require`, and runs with `node --test` on the source ([0011](./tests-next-to-the-source.md)).
  The line coverage of the `.mts` files has a floor of its own (`scripts/mts-coverage.mjs`,
  `server/.mts-coverage-ratchet.json`).

## Consequences

- Still no build step and no second copy of the server; `node --test path/to/x.test.js` keeps
  working on the source.
- The tree holds two module systems. A tool that reads only `import` and `require` misses every
  edge that goes through `nodeRequire`. Both gates did, until they were taught the call; their
  budgets were then raised once to the measured numbers, and each budget file says so in its
  `_note` (`server/.layering-ratchet.json`, `server/.scc-ratchet.json`). A new tool that walks the
  import graph has to read the same call.
- What `nodeRequire` returns is untyped. A `.mts` file writes the shape it expects next to the call
  (`nodeRequire('../stores/userStore') as { … }`), and nothing checks that shape against the
  module it loads.
- A `.mts` file may use erasable syntax only, which rules out a few TypeScript features for good.
- JSDoc stays more verbose than TypeScript syntax for the old files, and the loose forms `{any}`,
  `{*}`, `{Function}` and `{Object}` stay counted by a ratchet that may only decrease
  (`npm run lint:jsdoc-loose-type-ratchet`).
