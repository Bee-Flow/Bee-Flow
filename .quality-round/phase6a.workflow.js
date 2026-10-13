export const meta = {
  name: 'bee-flow-quality-phase6a',
  description: 'Phase 6: enforce best practices — pattern ratchets, lower frozen budgets, mobile/desktop/python/components gates, scripts hygiene',
  phases: [{ title: 'Gates', detail: '4 file-disjoint lanes that do not touch server core; runs beside phase 5 wave 3' }],
}
const S = args.scratch
const MODEL = args.model || 'opus'
const LANES = [
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
    ] },]
const RESULT = { type: 'object', properties: {
  id: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'skipped'] },
  files_changed: { type: 'array', items: { type: 'string' } },
  tests_run: { type: 'string' }, tests_green: { type: 'boolean' },
  behaviour_notes: { type: 'string' }, open_questions: { type: 'string' } },
  required: ['id', 'status', 'files_changed', 'tests_run', 'tests_green', 'behaviour_notes', 'open_questions'] }

const prompt = (lane, item, prev) => `You implement ONE best-practice item of a verified code-quality plan for the Bee Flow monorepo (repository root is the current working directory; branch ccr-8c0edf67-243f59; other agents edit OTHER files at the same time: stay inside your lane and re-read a file right before editing it). Context of the whole round: ${S}/HANDOVER.md and ${S}/synthesis.json (best_practices and ratchets lists).

Item ${item.id}: ${item.text}
${prev ? `Earlier items in this lane already changed: ${prev}.` : ''}

Rules: the app keeps working exactly as users know it (gates, tests, tooling and pure moves only); CLAUDE.md conventions apply (ratchets only lower, a new lint:* script is registered in root package.json, a new workflow job needs lint:checks/lint:workflows green, tests next to source); stay inside: ${lane.files}. Verify what you touched (node --test / vitest related / jest / pytest / npm run verify as applicable, npm run test:scripts and npm run check:fast after touching scripts/ or ratchets). Do NOT run the big suites inside the agent. Do NOT git commit, stash, checkout or reset.
At the same time another workflow is splitting server/index.js and the K5 removal will delete the Component Designer (routes/components.js, routes/ai/agentChat.js, the component_designer capability): do not touch server/index.js or server/core, and treat a transiently red server gate in check:fast as not yours (report it, do not fix it). Python: guard-service/.venv exists (made with uv: "uv venv .venv --python 3.12 && uv pip install -p .venv/bin/python -r requirements-dev.txt ruff==0.16.4"); make classify-service/.venv the same way; both .venv folders are git-excluded locally. Cap jest and vitest with --maxWorkers=2.`

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
