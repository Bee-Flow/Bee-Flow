---
title: "0001: The server stays JavaScript, typed with JSDoc"
description: Why server/ is CommonJS JavaScript with JSDoc types that are checked per file at three rising levels, instead of a TypeScript conversion with a build step.
---

# 0001: The server stays JavaScript, typed with JSDoc

**Status:** accepted, in effect. **Enforced by:** `server/scripts/typecheck.mjs`,
`scripts/checkjs-ratchet.mjs`, `scripts/check-new-code-types.mjs`.

## Context

The frontend (`agent-hub/`) is being converted from JavaScript to strict TypeScript, file
by file, with a gate that proves the compiled program did not change. The server is
larger, CommonJS, and runs its source directly: a TypeScript conversion would mean a
build step, `module.exports` turned into `export` across hundreds of files, and a period
in which `require` paths and `.d.ts` files drift. The server's tests import its modules
with plain `require`, and so does `agent-hub`'s test suite.

## Decision

The server stays JavaScript and CommonJS. Types are written as JSDoc and checked by the
TypeScript compiler with `checkJs`, but only for the files that opt in with a marker line
in their header: `// @typecheck`, `// @typecheck noImplicitAny` or `// @typecheck strict`.
A new file starts at `strict`; an old one moves up one level at a time. The number of
files at each level may only rise (`npm run lint:checkjs-ratchet`). The marker is read by
the server's own script, not by `// @ts-check`, so the frontend's typecheck, which reaches
server files through the tests, is not affected by the server's pace.

Types come from tooling first (`scripts/jsdoc-convert-server.mjs` and
`scripts/jsdoc-round.sh`: comments only, proven by a compiled diff) and from people second.

## Consequences

- No build step, no second copy of the server, and `node --test path/to/x.test.js` keeps
  working on the source.
- JSDoc is more verbose than TypeScript syntax and some shapes are awkward in it (generic
  imported types are written inline). The loose forms `{any}`, `{*}`, `{Function}` and
  `{Object}` are counted by a ratchet and may only decrease.
- A JavaScript file's untyped parameters are optional until its JSDoc documents one of them;
  from then on the undocumented ones are required. Tooling therefore types all of a
  function's parameters or none.
