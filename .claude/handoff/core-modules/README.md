# Handoff: splitting Bee Flow into a core and first-party modules

Working material for continuing the split in another session. Claude Code is the driver: it
writes the briefs, merges, runs the gates and verifies where a gate cannot judge. Workers are
Opus agents at low or medium effort, each in its own worktree.

## The goal, as the owner decided it

- **Core**: chat, knowledge bases, memory, agents, and the platform under them (auth, users
  and organisations, model providers, privacy shield, licence, admin, the module system).
- **Modules**: everything else, each physically in `modules/<id>/` in this repository, loaded
  through the module system. Modules may depend on each other; the core depends on none.
- As little code modification as possible: moves are mechanical and every step has a gate.
- Order: first the core perfect (it boots without any module, and every test that belongs to
  the core passes with all modules hidden), then at most three easy modules of different
  kinds (`learning`, `support`, `int_google`), then stop and evaluate, then the rest.
- With every module enabled the GUI stays exactly as it is.
- Later modules come from the Hub; the full image (core plus all modules) stays the default.
- Stays core for now: skills, swarms, dictation, the MCP client, image generation, the
  integration framework and first-party chat tools, Entra and Nextcloud login and user sync,
  the project container (stores, access), plans and entitlements. The mobile app stays one
  directory and one APK.

## The mechanism

- **One tree, several roots.** A file keeps its path relative to its root (its tree path) when
  it moves from `server/` to `modules/<id>/server/`. `server/moduleRoots.cjs` makes all roots
  resolve as one tree, so no import line changes and a move is a pure `git mv`. Paths computed
  by hand go through `treePath()`, `listTreeDir()`, `dataPath()`, `repoPath()`.
- **Core mode.** `BEEFLOW_HIDE_MODULES=all` (development and CI) makes module-owned files
  count as absent, also while they still sit in `server/`. This is how the core is made and
  kept perfect before anything moves.
- **Ownership.** `scripts/module-map.json` gives every file of `server/` and `agent-hub/src`
  to the core or to one of 23 modules. `node scripts/module-map.mjs --summary`, `--owner`,
  `--list <id>`, `--edges`.
- **Composition.** A module's rows of the server's composition (mounts, registrations, jobs,
  stores, migrations) live in `firstParty/<id>.js` and its part files; the loader is
  `server/modules/firstParty/loader.js` and the order stays the core's
  (`server/modules/firstParty/order.json`). States: absent, loaded, failed.
- **The full image is the merged tree**: the build copies the module trees over the core at
  their tree paths, so production keeps today's layout and the resolver is idle there.

## Gates that exist

| Gate | What it holds |
|---|---|
| `npm run lint:module-boundary-ratchet` (in `check:fast`) | core -> module import edges and lookups only go down; module -> module edges are declared; a moved module leaves nothing behind |
| `server/boot/composition.*.characterisation.test.js` | today's mounts, stores, migrations, registries and jobs, recorded from the running code; they must stay green, unchanged, while rows move into composition files |
| `scripts/roots-inventory.json` (`npm run test:scripts`) | every tool that names a package directory is root-aware, not applicable, or counted as pending |
| `server/moduleRoots.test.js` and `server/modules/roots/*.test.js` | the resolver |
| `cd server && node scripts/run-tests.mjs --scope core --hide-modules all` | the core's tests with every module hidden |

## Where the work stands

See `STATUS.md` in this directory: it is updated at the end of every batch.

## Work lists in this directory

- `core-mode-failing-files.txt`: the core test files that fail with all modules hidden
  (the baseline of "core perfect").
- `rehearsal/REPORT.md` and `rehearsal/conversions.json`: the dress rehearsal that moved all
  23 modules at once in a throwaway worktree. `conversions.json` lists every hand-computed
  path, directory scan and source-text read that crosses a module boundary, with file, line,
  kind and module; these are converted to the helpers before the module they belong to moves.

## How to move a module (once its turn has come)

```bash
node scripts/module-move.mjs <id> --dry      # what would move and which files it rewrites
node scripts/module-move.mjs <id>            # one commit, green by itself, or nothing
```

To undo a rehearsal use `git reset --hard HEAD && git clean -fdx modules/` (`-x`: the ignored
`node_modules` links otherwise leave empty module roots behind).
