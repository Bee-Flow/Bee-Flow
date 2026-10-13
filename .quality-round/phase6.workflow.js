export const meta = {
  name: 'bee-flow-quality-phase6',
  description: 'Phase 6: enforce best practices — pattern ratchets, lower frozen budgets, mobile/desktop/python/components gates, scripts hygiene',
  phases: [{ title: 'Gates', detail: '6 file-disjoint lanes; one Opus agent per item' }],
}
const S = args.scratch
const MODEL = args.model || 'opus'
const LANES = [
  { key: 'pattern-ratchets', files: 'scripts/count-ratchet.mjs (+ test), root package.json lint:* lines, server/.*-ratchet.json, agent-hub/.*-ratchet.json, CLAUDE.md (one line per new ratchet)',
    items: [
      { id: 'RATCHETS', text: 'Add count-ratchet metrics (each with its budget measured on the current tree, lowering only, registered as lint:<name>-ratchet in root package.json so check:fast picks it up, one line in CLAUDE.md): `empty-catch` (catch blocks whose body is empty or only a comment, server and agent-hub), `rollback-in-store` (literal ROLLBACK in server/stores outside db.withTransaction), `db-in-routes` (require of ../db or db.js inside server/routes), `long-function` (functions over 200 lines in server and agent-hub, measured with a simple brace-depth scanner; document its limits in the metric comment). Skip metrics that phase 4 already added (local-zod-helper, sse-head, unchecked-mutation, authfetch-outside-api, inline-pglite): check scripts/count-ratchet.mjs first. npm run test:scripts, npm run check:fast.' },
      { id: 'LOWER-BUDGETS', text: 'Lower every frozen budget to its measured value after phases 1-5: run each count ratchet and the eslint budget with --update (they only lower): big-file (server, agent-hub), module-mock, dutch-comment, style, fire-event, authfetch-effect, import-zones, scc, layering (node server/layering.test.js --update), duplication (node scripts/duplication-ratchet.mjs --update; ~2 minutes), eslint-budget agent-hub, source-text, status-5xx, checkjs (raise: node scripts/checkjs-ratchet.mjs server --update after adding // @typecheck to the modules the splits created, where it passes typecheck), version-drift, file-budget. Then make `node scripts/check-fast.mjs --list` print the slack per ratchet (measured vs budget) when run with --slack; test it. Report the before/after table in behaviour_notes.' },
    ] },
  { key: 'mobile-desktop', files: 'scripts/audit-ratchet.mjs (+ test), .github/security/audit-baseline.json, mobile/package.json overrides, mobile/package-lock.json, scripts/i18n-ratchet.mjs, mobile/.i18n-ratchet.json, desktop/eslint.config.* and desktop/src/main/** only where no-floating-promises reports',
    items: [
      { id: 'H25', text: 'Mobile dependencies sit outside the npm-audit ratchet: scripts/audit-ratchet.mjs TARGETS misses mobile (scripts/packages.json calls it a shipped client); npm audit --omit=dev in mobile shows 1 critical / 30 high. Add { dir: "mobile" } to TARGETS, record the floor in .github/security/audit-baseline.json, and add overrides for shell-quote and @xmldom/xmldom (and the other findings) where Expo allows the fixed versions (npm ls to confirm nothing breaks; ./node_modules/.bin/jest --maxWorkers=4 on the related tests, npm run typecheck). Run npm run lint:deps and npm run test:scripts.' },
      { id: 'I18N-MOBILE', text: 'Add the i18n ratchet for mobile: node scripts/i18n-ratchet.mjs mobile with a budget file mobile/.i18n-ratchet.json measured now (~297 literals), registered as lint:i18n-ratchet-mobile in root package.json (check:fast picks it up), with the scripts test extended. Do not change mobile strings.' },
      { id: 'DESKTOP-PROMISES', text: 'desktop: enable @typescript-eslint/no-floating-promises with projectService for src/main in desktop/eslint.config.*; fix every report by awaiting or by an explicit `void` with a one-line reason, behaviour unchanged; cd desktop && npm run verify.' },
    ] },
  { key: 'python', files: 'guard-service/pyproject.toml or ruff config, guard-service/app/**, guard-service/tests/**, classify-service equivalents, .github/workflows/ci.yml python steps only if a new command must run',
    items: [
      { id: 'PY-LINT', text: 'Python services: enable ruff rule sets B, S, UP, I (and pyright on app/ if it runs clean within an hour of fixes; otherwise add it as a non-blocking step and report), fix the findings without behaviour change, replace F401-noqa re-exports with __all__, pin the ruff version in one place (the same the CI pins), and extract the fakes that guard-service/tests/test_pii.py (2728 lines) and its siblings repeat into tests/fakes.py + conftest.py (no test deleted, no assertion changed). Run the full pytest for both services (they are small) and ruff.' },
    ] },
  { key: 'components', files: 'components/**, scripts/packages.json, .github/dependabot.yml, .github/workflows/ci.yml (components job only), root package.json',
    items: [
      { id: 'COMPONENTS-GATES', text: 'components/ has no lint and no smoke tests: add an eslint config that extends the server base config, a smoke test per component (stdin JSON in, JSON out, run with node --test), lockfiles + npm ci where a component has dependencies (register each in scripts/packages.json and dependabot.yml: npm run lint:package-registry must pass), and a `components` job or step in ci.yml behind the path filter (npm run lint:checks and lint:workflows must pass). Behaviour of the components unchanged.' },
    ] },
  { key: 'scripts', files: 'scripts/rotate-master-key.js, server/scripts/**, scripts/README.md, .github/workflows/ci.yml path filter line for server/scripts, server/scripts/lib/**',
    items: [
      { id: 'H27', text: 'scripts/rotate-master-key.js ("run on one app node", requires ../server/db) is not in the server image (image context is ./server). Pure move to server/scripts/rotateMasterKey.js; update its test require, the ci.yml path filter and scripts/README.md in the same change. Then group server/scripts into {test,ops,dev,content} subfolders with a README table, convert the ops scripts to node:util parseArgs strict with a shared ops-lib for dry-run/--apply (fail-closed), keeping every script\'s flags and output identical; run each script\'s tests.' },
    ] },
  { key: 'docs-core', files: 'server/ARCHITECTURE.md, CLAUDE.md, the loose files directly under server/core/ (not in a domain folder) and their importers (shims at old paths)',
    items: [
      { id: 'CORE-LOOSE', text: 'server/ARCHITECTURE.md still advises `node --test --test-force-exit`: remove it (CLAUDE.md explains why). Then move the loose files directly under server/core/ (list them: find server/core -maxdepth 1 -name "*.js" ! -name "*.test.js") into their domain folders per ARCHITECTURE.md as pure moves with re-export shims at the old paths (tests move along), update ARCHITECTURE.md\'s layout section, run the moved tests, lint:layering-ratchet, lint:scc-ratchet, check:fast.' },
    ] },
]
const RESULT = { type: 'object', properties: {
  id: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'skipped'] },
  files_changed: { type: 'array', items: { type: 'string' } },
  tests_run: { type: 'string' }, tests_green: { type: 'boolean' },
  behaviour_notes: { type: 'string' }, open_questions: { type: 'string' } },
  required: ['id', 'status', 'files_changed', 'tests_run', 'tests_green', 'behaviour_notes', 'open_questions'] }

const prompt = (lane, item, prev) => `You implement ONE best-practice item of a verified code-quality plan for the Bee Flow monorepo (repository root is the current working directory; branch ccr-8c0edf67-243f59; other agents edit OTHER files at the same time: stay inside your lane and re-read a file right before editing it). Context of the whole round: ${S}/HANDOVER.md and ${S}/synthesis.json (best_practices and ratchets lists).

Item ${item.id}: ${item.text}
${prev ? `Earlier items in this lane already changed: ${prev}.` : ''}

Rules: the app keeps working exactly as users know it (gates, tests, tooling and pure moves only); CLAUDE.md conventions apply (ratchets only lower, a new lint:* script is registered in root package.json, a new workflow job needs lint:checks/lint:workflows green, tests next to source); stay inside: ${lane.files}. Verify what you touched (node --test / vitest related / jest / pytest / npm run verify as applicable, npm run test:scripts and npm run check:fast after touching scripts/ or ratchets). Do NOT run the big suites inside the agent. Do NOT git commit, stash, checkout or reset.`

phase('Gates')
const results = await parallel(LANES.map(lane => async () => {
  const out = []; let prev = ''
  for (const item of lane.items) {
    const r = await agent(prompt(lane, item, prev), { label: `${lane.key}:${item.id}`, phase: 'Gates', schema: RESULT, model: MODEL })
    out.push(r || { id: item.id, status: 'skipped', files_changed: [], tests_run: '', tests_green: false, behaviour_notes: '', open_questions: 'agent returned null' })
    if (r) prev += (prev ? '; ' : '') + `${item.id}: ${r.files_changed.slice(0, 10).join(', ')}`
    log(`${lane.key}: ${item.id} ${r ? r.status : 'null'}`)
  }
  return { lane: lane.key, items: out }
}))
return results.filter(Boolean)
