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

1. `node scripts/ts-convert-local.mjs --batch .claude/handoff/ts-conversion/batches/NN.txt`
   (local model drafts; `--endpoint`/`--model` or `LOCAL_LLM_ENDPOINT`/`LOCAL_LLM_MODEL`).
   Without a local model, draft the files yourself with the same rules.
2. Update importers that name a converted file WITH an extension
   (`git grep -n "<basename>.jsx'"`), and `readFileSync`/`vi.mock` paths in tests.
3. `cd agent-hub && npm run typecheck` → fix with types only.
4. Commit the batch, then `node scripts/ts-equivalence.mjs HEAD~1 HEAD --diff`. For
   each DIFFERENT file: restore the original code and type it, or revert it
   (`git mv` back, `git checkout HEAD~1 -- <old path>`). Repeat 3–4 until `0 different`.
5. `npx eslint <changed files>`; `npx vitest run <tests importing the changed files>`
   (not `vitest related`: too slow); `node scripts/file-budget.mjs agent-hub` (types
   that push a file past its ceiling move to `<Name>.types.ts`);
   `node scripts/ts-ratchet.mjs agent-hub --update`.
6. Review by a separate Opus subagent: gate, forbidden constructs, lazy types where a
   real type exists nearby, dropped lines/props, importers, skipped files identical to
   base, checks. Merge only an approved batch.
7. After every few batches: `npm run check:fast`, the full `cd agent-hub && npm run
   test:run`, the mobile tests that read agent-hub source
   (`cd mobile && ./node_modules/.bin/jest $(grep -rlE "'(server|agent-hub)/" src
   --include=*.test.ts --include=*.test.tsx | xargs grep -lE "readFileSync|read\(")`),
   push, and let CI (`build-push-ghcr.yml`, channel dev) build before a dev deploy via
   `Bee-Flow-AI-internal/.github/workflows/deploy-dev.yml` (dry run first).

## Local model: what the research says (October 2026)

Decode on Strix Halo (Ryzen AI Max+ 395) is bound by memory bandwidth (~256 GB/s),
so bytes read per token decide the speed, not parameter count. Measured by the
community with llama.cpp on Vulkan (RADV):

| Model | Weights (4-bit) | Decode | Note |
|---|---|---|---|
| Qwen3-Coder-30B-A3B (MoE, 3B active) | 16–24 GB | ~95 tok/s | fast, leaves ~40 GB free; older (mid-2025) |
| Qwen3.6-35B-A3B (MoE) | ~22 GB | ~63 tok/s (124 with MTP in colibri) | newer general model, strong on code |
| Qwen3-Coder-Next 80B-A3B (MoE) | 48–52 GB | 51 (ollama) – 63 tok/s | best quality that fits 64 GB; tight with typecheck running |
| Qwen3.8-27B / Devstral Small 2 (dense) | 16–17 GB | 12–16 tok/s (30–36 with MTP) | too slow for whole-file drafts |

A 300-line file is ~3.5k output tokens: ~40 s at 95 tok/s, ~65 s at 55, ~4 min at 14.
Dense models are therefore out. Runtime: llama.cpp `llama-server`, Vulkan backend,
`-fa 1 -c 32768 -ctk q8_0 -ctv q8_0 -b 2048 -ub 2048 --parallel 2`; the tuned
gfx1151 build at github.com/Nathanw1014/strix-halo-llamacpp bundles a current Mesa
RADV and fixes MoE prefill. Ollama works too but is slower on this chip and has had
unified-memory detection regressions (0.30+); if used, `OLLAMA_VULKAN=1` and check
`ollama ps` shows the model on GPU.

Memory: BIOS UMA frame buffer small (512 MB–2 GB); Linux maps the rest through GTT.
The 30B/35B MoE models fit the default GTT (half of RAM). Coder-Next needs
`amdgpu.gttsize=57344 ttm.pages_limit=14680064` (56 GiB) on the kernel command line,
leaving ~8 GB for the OS and the typecheck, which is tight; do not run two typechecks
at once with it loaded.

Decision rule: the gate makes a bake-off cheap. Run batch 42 with Qwen3-Coder-30B-A3B,
then with Qwen3-Coder-Next; compare gate pass rate (identical files / drafted files),
skipped files and wall time. Keep the one with the higher pass rate unless it is more
than twice as slow. A pass rate under ~60% for both means the local model is too weak
for this; let Claude draft and keep the local model for `utils/` and `components/shared/`.
