# Handoff: agent-hub JavaScript → TypeScript conversion

Working material for continuing the conversion in another Claude Code session (for
example on a laptop with a local model doing the first draft). Claude Code stays the
driver: it decides, verifies, repairs, reviews and commits. Any model that drafts a
file is a tool, nothing more.

## Where the work stands

- Branch: `ccr-28820270-xkvwp8` (all quality rounds so far; CI green at `e24d091c`,
  deployed to dev). Fetch it first, nothing here lives on `main` yet.
- `batches/NN.txt`: the 42 batches, one path per line relative to `agent-hub/`. A
  batch is DONE when none of its paths exists any more as `.js`/`.jsx` (the driver
  script skips missing files, so re-running a finished batch is harmless).
- `ts-wip/*` branches on origin: conversions in flight from the cloud session.
  `ts-wip/worktree-wf_b6d20fca-c0a-*` (batches 1–7, 9–22, drafted by Haiku, under
  repair), `ts-wip/worktree-wf_30d02014-638-*` (the pilot: `components/shared`,
  `utils`), `ts-wip/worktree-wf_adc1176b-8e4-*` (Sonnet, batches 8, 21, 23–42, in
  progress). Each must pass the gate and an Opus review before it is merged. Check
  `git log ccr-28820270-xkvwp8..origin/ts-wip/<name>` before touching one; a branch
  already merged shows no commits.
- Measured so far: without the gate, Haiku changed the compiled program in 36% of
  files (one real bug: a dropped `hint=` prop). With the gate every merged file is
  identical by construction.

## The one rule

`node scripts/ts-equivalence.mjs <base> <head> --diff` compiles the old `.jsx` and the
new `.tsx` to JavaScript and compares them. Only a file reported identical may stay
converted. A file that cannot be typed without changing code (Date arithmetic,
`end - start`) goes back to JavaScript, byte-identical to the base. No `any`,
`as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, non-null `!`, new
`eslint-disable`.

## The loop, per batch (Claude Code runs this)

Two passes for the draft, one gate, one review. Measured on the laptop (Strix Halo,
Qwen3.6-35B-A3B Q5_K_XL with MTP, 12 files): pass 1 greedy with thinking off runs at
~80 tok/s and leaves 3 of 4 files clean against strict; pass 2 with thinking on, only
for the rejects, is 3–5× slower and fixed every one. Logic stayed byte-for-byte.

1. Pass 1: `node scripts/ts-convert-local.mjs --batch .claude/handoff/ts-conversion/batches/NN.txt`
   (greedy, thinking off, 3 files in flight; `--endpoint`/`--model` or
   `LOCAL_LLM_ENDPOINT`/`LOCAL_LLM_MODEL`). Without a local model, draft the files
   yourself with the same rules.
2. Update importers that name a converted file WITH an extension
   (`git grep -n "<basename>.jsx'"`), and `readFileSync`/`vi.mock` paths in tests.
3. `cd agent-hub && npm run typecheck`: the PROJECT tsconfig, never an isolated `tsc`
   (an isolated run reports missing `@types/node` as if the model failed). Note the
   files with errors; the usual ones are TS7006/TS7031 on React callback parameters
   and destructured props.
4. Pass 2: put the rejected files back (`git mv` to the old name, `git checkout -- <old path>`)
   and rerun them with `--thinking --only a.jsx,b.jsx`. Typecheck again. What still
   fails you type by hand (types only) or revert to JavaScript.
5. Commit the batch, then `node scripts/ts-equivalence.mjs HEAD~1 HEAD --diff`. For
   each DIFFERENT file: restore the original code and type it, or revert it
   (`git mv` back, `git checkout HEAD~1 -- <old path>`). Repeat 3–5 until `0 different`.
6. `npx eslint <changed files>`; `npx vitest run <tests importing the changed files>`
   (not `vitest related`: too slow); `node scripts/file-budget.mjs agent-hub` (types
   that push a file past its ceiling move to `<Name>.types.ts`);
   `node scripts/ts-ratchet.mjs agent-hub --update`.
7. Review by a separate Opus subagent: gate, forbidden constructs, lazy types where a
   real type exists nearby, dropped lines/props, importers, skipped files identical to
   base, checks. Merge only an approved batch.
8. After every few batches: `npm run check:fast`, the full `cd agent-hub && npm run
   test:run`, the mobile tests that read agent-hub source
   (`cd mobile && ./node_modules/.bin/jest $(grep -rlE "'(server|agent-hub)/" src
   --include=*.test.ts --include=*.test.tsx | xargs grep -lE "readFileSync|read\(")`),
   push, and let CI (`build-push-ghcr.yml`, channel dev) build before a dev deploy via
   `Bee-Flow-AI-internal/.github/workflows/deploy-dev.yml` (dry run first).

Scope: the batches hold only `agent-hub/src` paths, which are ES modules. The server is
CommonJS and stays JavaScript (`// @typecheck` + JSDoc); never run the converter there,
it would turn `module.exports` into `export` across hundreds of files.

## Local model: the laptop setup (measured 2026-10-15)

Decode on Strix Halo is bound by memory bandwidth, so a mixture-of-experts model with
~3B active parameters is the only class that is fast enough; dense 27B runs at 12–16 tok/s.

- Model: Qwen3.6-35B-A3B-MTP, Q5_K_XL (unsloth UD), 26 GB. Fits the default GTT;
  leaves ~35 GB for the OS, the KV cache and the typecheck.
- Runtime: llama.cpp strix-halo build, Vulkan/RADV, as a separate bulk profile:
  `--ctx-size 98304 --parallel 3` (~32k per slot), `-fa on`, `-b 2048 -ub 1024`,
  KV `q8_0`, `--spec-type draft-mtp --spec-draft-n-max 3`, `--reasoning-budget 0`
  (the script switches thinking on per request for pass 2).
- Speed: ~80 tok/s single stream, prompt ~600 tok/s, ~8 s for a 40–60 line file.
  Parallelism does not scale on the iGPU (6 slots: 1.38× aggregate, 83→19 tok/s per
  stream): keep 3 slots and count on the single-stream speed.
- Open question: 12 files is a small sample. Batch 42 is the first real measurement;
  expect ~75% clean after pass 1 and ~95% after pass 2. Below ~60% after pass 2 the
  model is too weak for that folder; let Claude draft it.

Alternatives considered: Qwen3-Coder-30B-A3B (~95 tok/s, older), Qwen3-Coder-Next
80B-A3B (stronger, but 48–52 GB: too tight next to a typecheck on 64 GB).
