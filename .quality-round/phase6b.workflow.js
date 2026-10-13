export const meta = {
  name: 'bee-flow-quality-phase6b',
  description: 'Phase 6: enforce best practices — pattern ratchets, lower frozen budgets, mobile/desktop/python/components gates, scripts hygiene',
  phases: [{ title: 'Gates', detail: 'ratchets and the loose core files, after phase 5 and the K5 removal' }],
}
const S = args.scratch
const MODEL = args.model || 'opus'
const LANES = [
  { key: 'pattern-ratchets', files: 'scripts/count-ratchet.mjs (+ test), root package.json lint:* lines, server/.*-ratchet.json, agent-hub/.*-ratchet.json, CLAUDE.md (one line per new ratchet)',
    items: [
      { id: 'RATCHETS', text: 'Add count-ratchet metrics (each with its budget measured on the current tree, lowering only, registered as lint:<name>-ratchet in root package.json so check:fast picks it up, one line in CLAUDE.md): `empty-catch` (catch blocks whose body is empty or only a comment, server and agent-hub), `rollback-in-store` (literal ROLLBACK in server/stores outside db.withTransaction), `db-in-routes` (require of ../db or db.js inside server/routes), `long-function` (functions over 200 lines in server and agent-hub, measured with a simple brace-depth scanner; document its limits in the metric comment). Skip metrics that phase 4 already added (local-zod-helper, sse-head, unchecked-mutation, authfetch-outside-api, inline-pglite): check scripts/count-ratchet.mjs first. npm run test:scripts, npm run check:fast.' },
      { id: 'LOWER-BUDGETS', text: 'Lower every frozen budget to its measured value after phases 1-5: run each count ratchet and the eslint budget with --update (they only lower): big-file (server, agent-hub), module-mock, dutch-comment, style, fire-event, authfetch-effect, import-zones, scc, layering (node server/layering.test.js --update), duplication (node scripts/duplication-ratchet.mjs --update; ~2 minutes), eslint-budget agent-hub, source-text, status-5xx, checkjs (raise: node scripts/checkjs-ratchet.mjs server --update after adding // @typecheck to the modules the splits created, where it passes typecheck), version-drift, file-budget. Then make `node scripts/check-fast.mjs --list` print the slack per ratchet (measured vs budget) when run with --slack; test it. Report the before/after table in behaviour_notes.' },
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
