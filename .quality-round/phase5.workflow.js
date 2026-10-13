export const meta = {
  name: 'bee-flow-quality-phase5',
  description: 'Phase 5: wave-2 and wave-3 splits of the large stateful files, each behind a characterisation test',
  phases: [
    { title: 'Wave 2', detail: 'routes, stores, core/domain and agent-hub god-files, pure moves behind barrels' },
    { title: 'Wave 3', detail: 'security-critical files, one at a time, gate-order test first' },
  ],
}
const S = args.scratch
const MODEL = args.model || 'opus'
// Lanes are file-disjoint. On a 16-core machine the runtime runs up to 14 agents at once;
// pass args.maxLanes to run fewer lanes concurrently (the rest queue).
const WAVE2 = [
  { key: 'routes-ai', items: ['server/routes/ai/automationBuilder/chatStream.js', 'server/routes/ai/notebookChat.js', 'server/routes/ai/webpageChat.js'] },
  { key: 'routes-studio', items: ['server/routes/studioApps.js'] },
  { key: 'stores-a', items: ['server/stores/notebookStore.js', 'server/stores/studioAppStore.js', 'server/stores/projectStore.js', 'server/stores/knowledgeBases.js', 'server/stores/memoryStore.js'] },
  { key: 'stores-b', items: ['server/stores/transcriptionStore.js', 'server/stores/complianceStore.js', 'server/stores/usageStore.js', 'server/stores/studioAppDataStore.js'] },
  { key: 'core-a', items: ['server/core/kb/localKBIngest.js', 'server/core/automationRunner/execAi.js', 'server/core/integrations/integrationTools.js', 'server/core/providers/claude.js'] },
  { key: 'domain', items: ['server/projects/packaging/install.js', 'server/automation/builderTools/stepEditing.js', 'server/appStudio/fileIntake.js', 'server/services/stripeService.js'] },
  { key: 'agent-hub-builder', items: ['agent-hub/src/components/automation/Builder/BuilderShell.jsx', 'agent-hub/src/components/automation/Builder/BuildTab.jsx', 'agent-hub/src/components/automation/Builder/DiagramPane.jsx', 'agent-hub/src/hooks/useAutomationBuilderStream.ts'] },
  { key: 'agent-hub-studio', items: ['agent-hub/src/components/agents/AgentWizard/BuilderSplit.jsx', 'agent-hub/src/components/admin/Studio/AppStudio/runtime/components/AppDataGrid.jsx', 'agent-hub/src/components/admin/component-studio/ComponentBuilder.jsx', 'agent-hub/src/AgentHub.jsx'] },
]
const WAVE3 = ['server/core/agentRuntime/toolRoundExecutor.js', 'server/core/automationRunner/execution.js', 'server/auth/permissions.js', 'server/modules/packageLoader.js', 'server/index.js', 'server/auth/encryption.js']

const RESULT = { type: 'object', properties: {
  id: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'skipped'] },
  files_changed: { type: 'array', items: { type: 'string' } },
  lines_before: { type: 'integer' }, lines_after_main_file: { type: 'integer' },
  characterisation_test: { type: 'string' },
  tests_run: { type: 'string' }, tests_green: { type: 'boolean' },
  behaviour_notes: { type: 'string' }, open_questions: { type: 'string' } },
  required: ['id', 'status', 'files_changed', 'lines_before', 'lines_after_main_file', 'characterisation_test', 'tests_run', 'tests_green', 'behaviour_notes', 'open_questions'] }

const splitPrompt = (file, prev, wave) => `You split ONE long code file of the Bee Flow monorepo (repository root is the current working directory; branch ccr-8c0edf67-243f59; other agents edit OTHER files at the same time, so touch only this file, its new modules, its tests and the minimum of importers). The audited split proposal is the record for your file in ${S}/synthesis.json: python3 -c "import json;d=json.load(open('${S}/synthesis.json'));print(json.dumps([s for s in d['splits'] if s['file']=='${file}'],indent=1,ensure_ascii=False))". It is a proposal: keep its intent, adjust boundaries to what the code really does. Phases 1-4 already changed parts of the tree (see ${S}/HANDOVER.md): read the file as it is now.

File: ${file}  (wave ${wave})
${prev ? `Earlier items in this lane already changed: ${prev}.` : ''}

Order of work:
1. CHARACTERISATION FIRST. If the file has no colocated test that exercises its main flow, write one before touching the code: drive the real module with fakes injected through its existing seams (or a minimal _setDepsForTests seam), pin the current outputs/calls/order for the main paths (the "golden" behaviour). For wave 3 the test pins the ORDER of the security gates (name gate, confirmation hold, DLP restore, PII policy, egress) or the crypto round-trips (encrypt/decrypt/wrap/unwrap vectors) before anything moves.
2. SPLIT as pure moves: functions, constants and classes move verbatim into the new modules; the original path becomes a barrel (or keeps only the orchestration) and exports EXACTLY the same keys, so importers, router mounts (server/index.js mount order!) and tests keep working. Module-level state stays in one module. Lazy requires stay lazy. No new upward imports (lint:layering-ratchet and lint:scc-ratchet must not grow; the new lint:file-budget must pass: lower a personal ceiling only, never raise). agent-hub: new modules in TypeScript; i18n rule; style and big-file ratchets.
3. Tests move with the code they test; no assertion is dropped.
4. Verify: node --test on every test touching the file and new modules (server); npx vitest related --run <files> + npm run typecheck + npx eslint (agent-hub); npm run check:fast from the root. Do NOT run full suites inside the agent (the orchestrator runs them per phase). Do NOT git commit, stash, checkout or reset.
Behaviour must stay identical; a user or client must notice nothing. Return lines_before / lines_after_main_file and name the characterisation test file.`

phase('Wave 2')
const w2 = await parallel(WAVE2.map(lane => async () => {
  const out = []; let prev = ''
  for (const file of lane.items) {
    const r = await agent(splitPrompt(file, prev, 2), { label: `${lane.key}:${file.split('/').pop()}`, phase: 'Wave 2', schema: RESULT, model: MODEL })
    out.push(r || { id: file, status: 'skipped', files_changed: [], lines_before: 0, lines_after_main_file: 0, characterisation_test: '', tests_run: '', tests_green: false, behaviour_notes: '', open_questions: 'agent returned null' })
    if (r) prev += (prev ? '; ' : '') + `${file}: ${r.files_changed.slice(0, 8).join(', ')}`
    log(`${lane.key}: ${file} ${r ? r.status : 'null'}`)
  }
  return { lane: lane.key, items: out }
}))

phase('Wave 3')
// One at a time: these hold the security gates and the key handling.
const w3 = []
let prev3 = ''
for (const file of WAVE3) {
  const r = await agent(splitPrompt(file, prev3, 3), { label: `wave3:${file.split('/').pop()}`, phase: 'Wave 3', schema: RESULT, model: MODEL, effort: 'high' })
  w3.push(r || { id: file, status: 'skipped', files_changed: [], lines_before: 0, lines_after_main_file: 0, characterisation_test: '', tests_run: '', tests_green: false, behaviour_notes: '', open_questions: 'agent returned null' })
  if (r) prev3 += (prev3 ? '; ' : '') + `${file}: ${r.files_changed.slice(0, 8).join(', ')}`
  log(`wave3: ${file} ${r ? r.status : 'null'}`)
}
return { wave2: w2.filter(Boolean), wave3: w3 }
