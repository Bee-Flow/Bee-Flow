# Bee Flow E2E smoke harness

Playwright smoke tests for the Bee Flow app, authored as **natural-language
scenarios** and executed in two Claude-assisted modes:

- **generated** — Claude turns `scenarios/<id>.md` into a committed,
  reviewable Playwright spec (`tests/generated/<id>.spec.ts`). CI runs the
  spec deterministically; no API key needed at test time.
- **agentic** — Claude drives a live browser and executes the scenario
  directly, reporting a structured verdict. Also used as automatic
  **fallback** when a generated spec fails, to distinguish *spec rot* (app
  fine, spec stale) from a *real regression*.

In CI this suite gates production releases: `.github/workflows/e2e-smoke.yml`
boots a fresh stack from the freshly built images and runs `npm run smoke`;
`build-push-ghcr.yml` only promotes `:latest`/`:prod` tags after green.

## Setup (local)

```bash
cd e2e
npm install
npx playwright install chromium
cp .env.example .env   # fill in ADMIN_PASSWORD (+ ANTHROPIC_API_KEY for gen/agentic)
```

## Add a new scenario (3 steps)

1. `cp scenarios/_template.md scenarios/my-flow.md` and describe the steps
   and expected outcomes in plain language. Frontmatter picks the mode.
2. `npm run gen -- my-flow` — review the generated spec, then run it headed
   until green: `npx playwright test tests/generated/my-flow.spec.ts --headed`
3. Commit **both** files (`scenarios/my-flow.md` + the spec). CI's
   `npm run gen:check` fails when they drift apart.

For an **agentic-only** scenario (`mode: agentic`) step 2 is just
`npm run agentic -- my-flow --headed` — the `.md` alone is the test.

Selector ground truth lives in [context/app-map.md](context/app-map.md):
the generator may only use `data-testid`s documented there. Update it when
you add/rename testids on smoke-covered pages.

## Commands

| Command | What it does |
|---|---|
| `npm run smoke` | Full orchestrated run: playwright → agentic fallback → report |
| `npm test` | Just the generated Playwright specs |
| `npm run gen [-- <id>]` | (Re)generate spec(s) from scenario(s) — needs `ANTHROPIC_API_KEY` |
| `npm run gen:check` | Freshness gate (CI) — no API key needed |
| `npm run agentic -- <id> [--headed]` | Run one scenario agentically (watch Claude drive with `--headed`) |
| `npm run analyze` | Rewrite `artifacts/smoke-report.md` from the last run summary |

Useful env vars: `E2E_SCENARIO=<id>` (run one scenario through `smoke`),
`E2E_MODE=agentic` (force a mode globally), `E2E_FALLBACK=0` (disable
fallback), `E2E_CAPABILITIES=llm,search` (what the target stack offers —
scenarios whose `requires` isn't covered are skipped).

## Exit codes of `npm run smoke`

| Code | Meaning |
|---|---|
| 0 | all pass (skips OK) |
| 1 | real / unverified regression |
| 2 | only spec-rot failures — app works, regenerate the spec(s) |
| 3 | infra error (stack down, login broken) |

The CI gate fails on 1, 2 and 3. Exit 2 exists so the release stays blocked
until the stale spec is regenerated (`npm run gen -- <id>`) — the report in
`artifacts/smoke-report.md` names the exact command.

## Layout

```
scenarios/        one .md per scenario (frontmatter + NL steps)
context/app-map.md  curated selector/route ground truth for Claude
prompts/          system prompts (generator, agentic runner, failure analyst)
tests/generated/  committed generated specs — never edit by hand
tests/            fixtures.ts (runId, AUTH_FILE), global-setup.ts (UI login)
runner/           gen / gen-check / agentic / analyze / smoke (Node ESM)
ci/               stack bootstrap scripts used by .github/workflows/e2e-smoke.yml
fixtures-data/    files scenarios may upload
artifacts/        run output (gitignored): pw-report.json, screenshots, smoke-report.md
```
