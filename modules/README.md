# modules/

One directory per first-party module: `modules/<id>/`.

- `modules/<id>/server/` mirrors the tree paths of `server/`. A file at
  `server/routes/foo.js` that belongs to module `<id>` lives at
  `modules/<id>/server/routes/foo.js`.
- `modules/<id>/frontend/` mirrors `agent-hub/`; its tree paths start at `src/`
  (`agent-hub/src/pages/Foo.tsx` becomes `modules/<id>/frontend/src/pages/Foo.tsx`).

**A file keeps its tree path when it moves.** Imports are not rewritten: the
resolver in `server/moduleRoots.cjs` (with `server/modules/roots/`) makes the core
root and every module root resolve as one tree, so `require('../core/x')` from a
module file finds `server/core/x`, and the other way round.

Per-root control files, in each `modules/<id>/server/` and `modules/<id>/frontend/`:

- `node_modules`: a link to the core's (`server/node_modules`, `agent-hub/node_modules`),
  made by `npm run modules:link` (`scripts/link-module-node-modules.mjs`). Not in git.
- `eslint.config.js`: the lint configuration of that root.
- `eslint-suppressions.json`: the eslint bulk suppressions of the files in that root.

Which module owns which file is recorded in `scripts/module-map.json`.

`modules/package.json` only makes `.js` files here CommonJS, like `server/`; it has
no dependencies and no scripts. `modules/.gitignore` applies the ignore rules of
`server/` and `agent-hub/` at the module paths and keeps their tracked `data/`
directories tracked (`scripts/modules-gitignore.test.mjs` proves it).
