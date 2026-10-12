const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');
const h = createBuilderStream();
after(() => h.restore());

const definition = { schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set', label: 'Original', settings: { assignments: [{ var: 'x', value: '1' }] } }], edges: [{ from: 'trg', to: 's1' }] };
const draft = () => ({ id: 'a1', userId: 'u1', title: 'My flow', description: '', definition: structuredClone(definition) });
const names = run => run.roundOptions(0).tools.map(t => t.function.name);

test('discuss refuses hallucinated mutation and dry-run calls before dispatch or persistence', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'discuss' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' }), call('builder_request_dry_run')] }, { text: 'Advice only.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    assert.equal(run.has('finalized'), false);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
    assert.ok(names(run).every(n => !['builder_update_step', 'builder_finalize', 'builder_request_dry_run'].includes(n)));
});

test('approval mode produces an isolated preview and saves the original definition in the session', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Proposed' })] }, { text: 'Review this change.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Proposed'; return { ok: true }; } } });
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    const proposal = run.last('proposal_preview');
    assert.ok(proposal.id);
    assert.equal(proposal.definition.steps[0].label, 'Proposed');
    assert.deepEqual(proposal.baseDefinition, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.proposal, proposal);
});

// ── tables in a preview ─────────────────────────────────────────────────────
//
// builder_create_datatable STAGES a table in Approve each change: nothing is
// created, the steps are bound to "pending:<n>", and the proposal carries the
// table. The real tool rules (staging, the consent gate) run behind `onTool`.

const TABLES = () => [
    { id: 'tbl_f1', key: 'facturen', name: 'Facturen', description: '', rowCount: 3, canWrite: true, managedKind: null, scope: 'org', columns: [{ key: 'datum', name: 'Datum', type: 'date' }] },
    { id: 'tbl_k1', key: 'klanten', name: 'Klanten', description: '', rowCount: 1, canWrite: true, managedKind: null, scope: 'org', columns: [{ key: 'naam', name: 'Naam', type: 'text' }] },
];
const NEW_TABLE = { name: 'Inkomende facturen', fields: [{ name: 'Datum', type: 'date' }, { name: 'Bedrag', type: 'number' }] };
const real = (name, args, wrap) => h.realApplyToolCall(name, args, wrap);

/** Fail the test when a table is created for real. */
function watchCreates() {
    const mod = require('../../../core/dataEngine/createStudioDatatable');
    const orig = mod.createStudioDatatable;
    const calls = [];
    mod.createStudioDatatable = async (args) => {
        calls.push(args);
        return { ok: true, table: { id: 'tbl_made', key: 'inkomende_facturen', name: args.name, scope: { kind: 'org', id: 'org1' }, fields: args.fields.map(f => ({ key: f.key, name: f.name, type: f.type })) } };
    };
    return { calls, restore: () => { mod.createStudioDatatable = orig; } };
}

test('preview cannot delegate a flowlet or finalize', async () => {
    const blocked = ['builder_generate_layer', 'builder_generate_layers', 'builder_finalize', 'webpage_db_exec'];
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: blocked.map(n => call(n)) }, { text: 'Awaiting approval.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.ok(names(run).every(n => !blocked.includes(n)));
});

test('approve mode STAGES a new table: no table is created, the draft is untouched, the proposal carries the table and the steps point at its pending id', async () => {
    const spy = watchCreates();
    try {
        const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'approve' },
            rounds: [
                { toolCalls: [call('builder_create_datatable', NEW_TABLE)] },
                { toolCalls: [call('builder_add_datatable', { op: 'add_row', datatableId: 'pending:1', datatableKey: 'inkomende_facturen', values: { datum: { kind: 'literal', value: '2026-01-01' } } })] },
                { text: 'Review this.' },
            ],
            onTool: real });
        assert.ok(names(run).includes('builder_create_datatable'), 'the tool is offered in approve mode');
        assert.equal(spy.calls.length, 0, 'createStudioDatatable was never called');
        assert.equal(run.persists.length, 0);
        assert.equal(run.has('draft'), false, 'the live draft is untouched');
        const created = run.dataOf('tool_call').find(c => c.name === 'builder_create_datatable').result;
        assert.deepEqual([created.datatableId, created.staged, created.changeStatus], ['pending:1', true, 'staged']);
        assert.ok(run.dataOf('tool_call').every(c => !c.result.error), JSON.stringify(run.dataOf('tool_call').map(c => c.result.error)));
        const proposal = run.last('proposal_preview');
        assert.equal(proposal.pendingDatatables.length, 1);
        assert.deepEqual([proposal.pendingDatatables[0].ref, proposal.pendingDatatables[0].name, proposal.pendingDatatables[0].fields.map(f => f.key)], ['pending:1', 'Inkomende facturen', ['datum', 'bedrag']]);
        assert.deepEqual(proposal.usedDatatables.map(u => [u.id, u.pending, u.newlyBound]), [['pending:1', true, true]]);
        const step = proposal.definition.steps.find(st => st.type === 'datatable');
        assert.equal(step.datatableId, 'pending:1');
        assert.deepEqual(run.storedSessions.at(-1).payload.proposal, proposal);
        assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition, 'the saved draft is the original');
        const errors = run.dataOf('validation_errors').flatMap(v => v.errors);
        assert.ok(!errors.some(e => e.code === 'datatable.table_pending'), 'a table this proposal stages is not a validation error');
    } finally { spy.restore(); }
});

test('a follow-up turn re-seeds the staged tables (no pending:2 for the same name) and keeps the proposal id when nothing changed', async () => {
    const first = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_create_datatable', NEW_TABLE)] }, { text: 'Staged.' }], onTool: real });
    const saved = first.storedSessions.at(-1).payload;
    assert.equal(saved.proposal.pendingDatatables.length, 1);
    const second = await h.run({ draft: draft(), datatables: TABLES(), builderSession: saved, body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_create_datatable', NEW_TABLE)] }, { text: 'Still staged.' }], onTool: real });
    const again = second.dataOf('tool_call')[0].result;
    assert.equal(again.datatableId, 'pending:1', 'the same table, not a second one');
    assert.equal(second.last('proposal_preview').id, saved.proposal.id, 'nothing changed: the proposal keeps its id');
    assert.equal(second.last('proposal_preview').pendingDatatables.length, 1);
    const note = second.roundMessages(0).filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(note, /STAGED TABLES \(not created yet; created when the user presses Apply; use these ids\): pending:1 · key inkomende_facturen · "Inkomende facturen" · columns: datum date, bedrag number\./);
});

test('a size-checked build with one step and one table ends as a proposal, never as a commit', async () => {
    const spy = watchCreates();
    try {
        const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
            rounds: [
                { toolCalls: [call('builder_create_datatable', NEW_TABLE)] },
                { toolCalls: [call('builder_add_datatable', { op: 'add_row', datatableId: 'pending:1', values: { datum: { kind: 'literal', value: 'x' } } })] },
                { text: 'Staged.' },
            ],
            onTool: real });
        assert.equal(spy.calls.length, 0);
        assert.equal(run.persists.length, 0, 'not committed');
        assert.equal(run.has('draft'), false);
        const created = run.dataOf('tool_call')[0].result;
        assert.equal(created._status, "Staged: a new table always waits for the user's Apply.");
        const proposal = run.last('proposal_preview');
        assert.equal(proposal.pendingDatatables.length, 1);
        assert.equal(run.storedSessions.at(-1).payload.proposal.id, proposal.id);
    } finally { spy.restore(); }
});

test('plan mode refuses to create a table, says where it goes, and stores the plan\'s tables', async () => {
    const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_create_datatable', NEW_TABLE), call('builder_write_plan', {
            title: 'Invoices', goal: 'Store invoices', steps: ['Add a row per invoice'],
            datatables: [{ name: 'Inkomende facturen', fields: [{ name: 'Datum', type: 'date' }, { name: 'Bedrag', type: 'number' }] }],
            useDatatables: ['tbl_k1', 'tbl_nope'],
        })] }, { text: 'Plan written.' }] });
    assert.equal(run.toolCalls.length, 0, 'nothing was dispatched');
    const refusal = run.dataOf('tool_call').find(c => c.name === 'builder_create_datatable').result;
    assert.match(refusal.error, /Put it in builder_write_plan's "datatables" list/);
    const plan = run.last('review_plan').plan;
    assert.deepEqual(plan.datatables.map(t => [t.name, t.fields.map(f => f.key)]), [['Inkomende facturen', ['datum', 'bedrag']]]);
    assert.deepEqual(plan.useDatatables, [{ id: 'tbl_k1', key: 'klanten', name: 'Klanten' }]);
    assert.deepEqual(run.storedSessions.at(-1).payload.reviewPlan.datatables, plan.datatables);
});

test('an approved-plan build creates only the tables the plan lists, and may bind to what it created', async () => {
    const spy = watchCreates();
    try {
        const reviewPlan = { id: 'p1', status: 'review', title: 'Invoices', steps: ['Store the invoices'], datatables: [{ name: 'Inkomende facturen', fields: [{ key: 'datum', name: 'Datum', type: 'date' }] }] };
        const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' }, builderSession: { reviewPlan },
            rounds: [
                { toolCalls: [call('builder_create_datatable', { name: 'inkomende facturen' }), call('builder_create_datatable', { name: 'Klanten extra', fields: [{ name: 'A', type: 'text' }] })] },
                { toolCalls: [call('builder_add_datatable', { op: 'add_row', datatableId: 'tbl_made', values: { datum: { kind: 'literal', value: 'x' } } })] },
                { text: 'Built.' },
            ],
            onTool: real });
        assert.deepEqual(spy.calls.map(c => c.name), ['inkomende facturen'], 'only the listed table was created, with the plan\'s columns');
        assert.deepEqual(spy.calls[0].fields.map(f => f.key), ['datum']);
        const results = run.dataOf('tool_call');
        assert.match(results[1].result.error, /"Klanten extra" is not in the approved plan, so no table was created/);
        assert.ok(!results[2].result.error, JSON.stringify(results[2].result));
        assert.ok(run.storedSessions.at(-1).payload.approvedDatatableIds.includes('tbl_made'), 'the new table is remembered as chosen');
    } finally { spy.restore(); }
});

// ── consent to bind an existing table ───────────────────────────────────────

const bindFacturen = (id = 'tbl_f1') => call('builder_add_datatable', { op: 'find_rows', datatableId: id });
const gateRun = (over = {}) => h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'approve' },
    rounds: [{ toolCalls: [bindFacturen()] }, { text: 'Done.' }], onTool: real, ...over });
const bindResult = (run) => run.dataOf('tool_call').find(c => c.name === 'builder_add_datatable').result;

test('the gate: an existing table the user never named is refused with a question to ask', async () => {
    const run = await gateRun({ message: 'Zoek de rijen op in een tabel' });
    const r = bindResult(run);
    assert.equal(r.code, 'datatable_choice_required');
    assert.deepEqual(r._askArgs.questions[0].datatableIds, ['tbl_f1']);
    assert.ok(!(run.last('proposal_preview')?.definition.steps || []).some(st => st.type === 'datatable'), 'no step was bound');
});

test('the gate: a table named in the user\'s message is allowed', async () => {
    const run = await gateRun({ message: 'Zoek de rijen op in de tabel Facturen' });
    assert.ok(!bindResult(run).error, JSON.stringify(bindResult(run)));
});

test('the gate: a table named only in the model\'s own question is NOT approved', async () => {
    const run = await gateRun({ message: 'Ja graag', body: { automationId: 'a1', workMode: 'approve', history: [{ role: 'user', content: 'Q: Shall I use the Facturen table?\nA: ja' }] } });
    assert.equal(bindResult(run).code, 'datatable_choice_required');
});

test('the gate: a table picked on a question card is allowed, and remembered in the snapshot', async () => {
    const questions = [{ id: 'q1', prompt: 'Which table?', options: ['Facturen', 'Klanten', 'Create a new table'], choice: { kind: 'datatable', access: 'write', options: [{ label: 'Facturen', datatableId: 'tbl_f1' }, { label: 'Klanten', datatableId: 'tbl_k1' }, { label: 'Create a new table', create: true }] } }];
    const run = await gateRun({ message: 'Q: Which table?\nA: Facturen', builderSession: { reviewQuestions: questions, version: 3 } });
    assert.ok(!bindResult(run).error, JSON.stringify(bindResult(run)));
    assert.ok(run.storedSessions.at(-1).payload.approvedDatatableIds.includes('tbl_f1'));
    const note = run.roundMessages(0).filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(note, /The user chose the existing table "Facturen" \(tbl_f1, key facturen\)\. Bind the step to it\./);
});

test('the gate: choosing "create a new table" tells the agent to create one', async () => {
    const questions = [{ id: 'q1', prompt: 'Which table?', options: ['Facturen', 'Create a new table'], choice: { kind: 'datatable', access: 'write', options: [{ label: 'Facturen', datatableId: 'tbl_f1' }, { label: 'Create a new table', create: true }] } }];
    const run = await gateRun({ message: 'Q: Which table?\nA: Create a new table', builderSession: { reviewQuestions: questions } });
    const note = run.roundMessages(0).filter(m => m.role === 'system').map(m => m.content).join('\n');
    assert.match(note, /The user wants a NEW table for: Which table\?\. Create it with builder_create_datatable\./);
    assert.equal(bindResult(run).code, 'datatable_choice_required', 'the existing table stays unchosen');
});

test('the gate: a table the flow already uses, or one carried from an earlier choice, is allowed', async () => {
    const used = { ...definition, steps: [...definition.steps, { id: 'd1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_f1', datatableKey: 'facturen' }], edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'd1' }] };
    const run = await gateRun({ draft: { ...draft(), definition: used } });
    assert.ok(!bindResult(run).error, 'bound in the live draft');
    const carried = await gateRun({ builderSession: { approvedDatatableIds: ['tbl_f1'] } });
    assert.ok(!bindResult(carried).error, 'carried in the snapshot');
});

test('without a work mode there is no gate (the caller is not the chat panel)', async () => {
    const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1' }, rounds: [{ toolCalls: [bindFacturen()] }, { text: 'Done.' }], onTool: real });
    assert.ok(!bindResult(run).error, JSON.stringify(bindResult(run)));
});

test('builder_ask_questions with datatableIds shows the tables plus the create option, and the client never sees `choice`', async () => {
    const run = await h.run({ draft: draft(), datatables: TABLES(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Which table?', datatableIds: ['tbl_f1', 'tbl_k1'], createLabel: 'Nieuwe tabel maken' }] })] }, { text: 'Waiting.' }] });
    const sent = run.last('review_questions').questions;
    assert.deepEqual(sent[0].options, ['Facturen', 'Klanten', 'Nieuwe tabel maken']);
    assert.equal('choice' in sent[0], false);
    const stored = run.storedSessions.at(-1).payload.reviewQuestions;
    assert.equal(stored[0].choice.kind, 'datatable');
    assert.deepEqual(stored[0].choice.options.map(o => o.datatableId || 'create'), ['tbl_f1', 'tbl_k1', 'create']);
});

const READ_DOCS = ['builder_search_documents', 'builder_read_document'];

test('document discovery is offered in every mode, so fill_document can be built in all of them', async () => {
    for (const workMode of ['discuss', 'approve', 'plan', 'build']) {
        const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode }, rounds: [{ text: 'Ok.' }] });
        for (const n of READ_DOCS) assert.ok(names(run).includes(n), `${n} is offered in ${workMode} mode`);
    }
    // …also in the size-checked build ("Ask before applying large changes").
    const buffered = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true }, rounds: [{ text: 'Ok.' }] });
    for (const n of READ_DOCS) assert.ok(names(buffered).includes(n), `${n} is offered in a size-checked build`);
});

test('approve mode: read the document, then add the fill_document step (the discovery gate is satisfiable)', async () => {
    const calls = [];
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [
            { toolCalls: [call('builder_read_document', { documentId: 'doc1' })] },
            { toolCalls: [call('builder_add_fill_document', { documentId: 'doc1' })] },
            { text: 'Proposed.' },
        ],
        // The gate itself is the real one: inspectBindings refuses the step
        // until a contract for doc1 was read on this draft.
        onTool: (name, args, wrap) => {
            calls.push(name);
            if (name === 'builder_read_document') { wrap._documentContracts = { doc1: { versionId: 'v1', parameters: [], sections: [] } }; return { contract: { versionId: 'v1' } }; }
            const refusal = require('../../../core/documents/documentDiscovery').inspectBindings(args, wrap, 'builder');
            if (refusal) return refusal;
            wrap.def.steps.push({ id: 'fill', type: 'fill_document', documentId: args.documentId });
            return { ok: true };
        } });
    assert.deepEqual(calls, ['builder_read_document', 'builder_add_fill_document']);
    assert.ok(run.last('proposal_preview').definition.steps.some(s => s.type === 'fill_document'));
    assert.ok(run.dataOf('tool_call').every(c => !c.result.error));
});

test('approve and plan modes offer a dry run; discuss does not', async () => {
    for (const [workMode, offered] of [['approve', true], ['plan', true], ['discuss', false], ['build', true]]) {
        const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode }, rounds: [{ text: 'Ok.' }] });
        assert.equal(names(run).includes('builder_request_dry_run'), offered, `dry run in ${workMode}`);
    }
});

test('a dry run in approve mode runs the STAGED definition: flagged staged, nothing persisted', async () => {
    let seen = null;
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_request_dry_run')] }, { text: 'Checked.' }],
        onTool: (name, _args, wrap) => {
            if (name === 'builder_update_step') { wrap.def.steps[0].label = 'Proposed'; return { ok: true }; }
            seen = { staged: wrap._stagedDryRun, label: wrap.def.steps[0].label };
            return { run: { id: 'r1', status: 'success' }, steps: [] };
        } });
    assert.deepEqual(seen, { staged: true, label: 'Proposed' });
    assert.equal(run.persists.length, 0, 'the proposal was not saved to run it');
    assert.equal(run.has('draft'), false);
    assert.equal(run.last('dryrun').run.id, 'r1');
    assert.equal(run.last('proposal_preview').definition.steps[0].label, 'Proposed');
});

test('a dry run in a direct build is not staged: it runs the saved draft', async () => {
    let staged = null;
    await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build' },
        rounds: [{ toolCalls: [call('builder_request_dry_run')] }, { text: 'Checked.' }],
        onTool: (_name, _args, wrap) => { staged = wrap._stagedDryRun; return { run: { id: 'r1', status: 'success' }, steps: [] }; } });
    assert.equal(staged, false);
});

test('a size-checked build may dry-run its staged changes (they are not applied yet)', async () => {
    let staged = null;
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { toolCalls: [call('builder_request_dry_run')] }, { text: 'Checked.' }],
        onTool: (name, _args, wrap) => {
            if (name === 'builder_update_step') { wrap.def.steps[0].label = 'Staged'; return { ok: true }; }
            staged = wrap._stagedDryRun;
            return { run: { id: 'r1', status: 'success' }, steps: [] };
        } });
    assert.equal(staged, true);
    assert.ok(run.toolCalls.some(c => c.name === 'builder_request_dry_run'));
});

const planWith = (steps) => ({ id: 'p1', status: 'review', title: 'Tidy', steps });

test('an approved plan that names a removal lets the build turn remove THAT step, and only that one', async () => {
    const two = { ...definition, steps: [...definition.steps, { id: 's2', type: 'set', label: 'Old totals', settings: { assignments: [] } }], edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }] };
    const withTwo = () => ({ id: 'a1', userId: 'u1', title: 'My flow', description: '', definition: structuredClone(two) });
    const removed = [];
    const run = await h.run({ draft: withTwo(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' },
        builderSession: { reviewPlan: planWith(['Remove the "Old totals" step', 'Rename the first step']) },
        rounds: [{ toolCalls: [call('builder_remove_step', { stepId: 's2' }), call('builder_remove_step', { stepId: 's1' })] }, { text: 'Done.' }],
        tools: { builder_remove_step: (args, wrap) => { removed.push(args.stepId); wrap.def.steps = wrap.def.steps.filter(s => s.id !== args.stepId); return { ok: true }; }, builder_finalize: () => ({ error: 'no' }) } });
    assert.ok(names(run).includes('builder_remove_step'), 'offered');
    assert.deepEqual(removed, ['s2']);
    const refused = run.dataOf('tool_call').find(c => c.arguments.stepId === 's1');
    assert.match(refused.result.error, /does not name/);
});

test('a scoped removal is judged in the flowlet it targets, and an unknown step is refused, not waved through', async () => {
    // x_7 exists only in the flowlet; the root has a step with the same id as another flowlet step.
    const layered = { ...definition,
        steps: [...definition.steps, { id: 'dup', type: 'set', label: 'Send email', settings: { assignments: [] } }],
        layers: { inv: { schemaVersion: 2, trigger: { id: 'ltrg', type: 'trigger', kind: 'manual' }, steps: [
            { id: 'x_7', type: 'set', label: 'Archive copy', settings: { assignments: [] } },
            { id: 'dup', type: 'set', label: 'Slack ping', settings: { assignments: [] } },
        ], edges: [] } } };
    const withLayer = () => ({ id: 'a1', userId: 'u1', title: 'My flow', description: '', definition: structuredClone(layered) });
    const removed = [];
    const run = await h.run({ draft: withLayer(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' },
        builderSession: { reviewPlan: planWith(['Remove the Slack ping step']) },
        rounds: [{ toolCalls: [
            call('builder_remove_step', { stepId: 'x_7', scope: 'inv' }),      // in the flowlet, never named
            call('builder_remove_step', { stepId: 'nope', scope: 'inv' }),     // not there at all
            call('builder_remove_step', { stepId: 's1', scope: 'missing' }),   // no such flowlet
            call('builder_remove_step', { stepId: 'dup', scope: 'inv' }),      // the flowlet's own "Slack ping"
            call('builder_remove_step', { stepId: 'dup' }),                    // the root's "Send email": not named
        ] }, { text: 'Done.' }],
        tools: { builder_remove_step: (args) => { removed.push(`${args.scope || 'root'}:${args.stepId}`); return { ok: true }; }, builder_finalize: () => ({ error: 'no' }) } });
    assert.deepEqual(removed, ['inv:dup']);
    const results = run.dataOf('tool_call').map(c => c.result.error || 'ok');
    assert.match(results[0], /does not name "Archive copy"/);
    assert.match(results[1], /Unknown stepId "nope" in flowlet "inv"/);
    assert.match(results[2], /Unknown stepId "s1" in flowlet "missing"/);
    assert.equal(results[3], 'ok');
    assert.match(results[4], /does not name "Send email"/);
});

test('an approved plan without a removal does not offer builder_remove_step', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' },
        builderSession: { reviewPlan: planWith(['Rename the step']) },
        rounds: [{ text: 'Ok.' }] });
    assert.ok(!names(run).includes('builder_remove_step'));
    assert.ok(run.roundMessages(0).some(m => m.content?.includes('Removing a step requires a separate human-approved proposal') && !m.content.includes('except a step this approved plan names')));
});

test('a plan is saved as a review document; no build happens before approval', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_write_plan', { title: 'New flow', goal: 'Process files', steps: ['Read files', 'Send a summary'], tests: ['Check an empty folder'] }), call('builder_update_step', { stepId: 's1' })] }, { text: 'Approve the plan.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.equal(run.first('review_plan').plan.status, 'review');
    assert.equal(run.first('review_plan').plan.version, 1);
    assert.equal(run.storedSessions.at(-1).payload.reviewPlan.title, 'New flow');
    assert.equal(run.roundOptions(0).toolChoice, 'auto');
});

test('an outdated plan approval is refused without any model calls', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'old' },
        builderSession: { reviewPlan: { id: 'new', status: 'review' } } });
    assert.equal(run.rounds.length, 0);
    assert.match(run.first('error').error, /latest plan/);
});

test('a plan for a changed definition must be reviewed again', async () => {
    const oldDefinition = { ...definition, steps: [] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' },
        builderSession: { reviewPlan: { id: 'p1', status: 'review', baseDefinition: oldDefinition } } });
    assert.equal(run.rounds.length, 0);
    assert.ok(run.has('error'));
});

test('bundled questions stop further tool execution until the user answers', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Which inbox?', options: ['Finance', 'Sales'] }] }), call('builder_update_step', { stepId: 's1' })] }, { text: 'This round must not run.' }] });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.first('review_questions').questions[0].prompt, 'Which inbox?');
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
});

test('an approved exact plan revision enables building and passes its scope to the model', async () => {
    const plan = { id: 'p1', status: 'review', title: 'Keep scope', steps: ['Rename the step'] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' }, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Done.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Approved'; return { ok: true }; }, builder_finalize: () => ({ error: 'Not finalized in this test.' }) } });
    assert.ok(run.toolCalls.some(c => c.name === 'builder_update_step'));
    assert.equal(run.first('draft').definition.steps[0].label, 'Approved');
    assert.ok(run.roundMessages(0).some(m => m.content?.includes('Follow this approved plan')));
});

test('large changes to an existing flow become a one-click proposal, not a plan to rebuild (BFSF-486)', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] })] }, { text: 'Review these changes.' }],
        tools: { builder_add_steps: (_args, wrap) => { wrap.def.steps.push(...Array.from({ length: 4 }, (_, i) => ({ id: `new${i}`, type: 'set', label: `Step ${i}` }))); return { ok: true }; } } });
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    assert.equal(run.has('review_plan'), false);
    const proposal = run.last('proposal_preview');
    assert.ok(proposal.id);
    assert.equal(proposal.definition.steps.length, 5);
    assert.deepEqual(proposal.baseDefinition, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.proposal, proposal);
});

test('a new flow from scratch is built directly, whatever its size (BFSF-486)', async () => {
    const blank = { id: 'a1', userId: 'u1', title: 'My flow', description: '', definition: { schemaVersion: 2, trigger: null, steps: [], edges: [] } };
    const run = await h.run({ draft: blank, body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] })] }, { text: 'Built.' }],
        tools: { builder_add_steps: (_args, wrap) => { wrap.def.steps.push(...Array.from({ length: 6 }, (_, i) => ({ id: `new${i}`, type: 'set', label: `Step ${i}` }))); return { ok: true }; } } });
    assert.ok(run.persists.length >= 1);
    assert.equal(run.last('draft').definition.steps.length, 6);
    assert.equal(run.has('proposal_preview'), false);
    assert.equal(run.has('review_plan'), false);
    assert.equal(run.last('tool_call').result.changeStatus, 'applied');
});

test('small direct builds are committed once after the size check', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'New' })] }, { text: 'Ready.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'New'; return { ok: true }; } } });
    assert.equal(run.persists.length, 1);
    assert.equal(run.last('draft').definition.steps[0].label, 'New');
    assert.equal(run.has('proposal_preview'), false);
    assert.equal(run.storedSessions.at(-1).payload.draft.steps[0].label, 'New');
});

test('an approved plan pauses after one mutation and skips later calls', async () => {
    const plan = { id: 'p1', status: 'review', title: 'Rename', steps: ['Rename the step', 'Add another step'] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1', pauseAfterStep: true }, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' }), call('builder_add_steps', { steps: [{ id: 'next' }] })] }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Renamed'; return { ok: true }; } } });
    assert.equal(run.toolCalls.length, 1);
    assert.equal(run.rounds.length, 1);
    assert.equal(run.last('review_plan').plan.status, 'paused');
    assert.equal(run.last('review_plan').plan.baseDefinition.steps[0].label, 'Renamed');
    assert.equal(run.has('finalized'), false);
});

// BFSF-486: the agent staged a change, then read the draft and saw the old
// steps, could not tell staged from applied, and a "yes" in the chat applied
// nothing. Below: stage → read the draft → stage more → the user's outcome.
const staged = () => {
    const def = structuredClone(definition);
    def.steps[0].label = 'Proposed';
    return { id: 'prop1', definition: def, baseDefinition: structuredClone(definition), title: 'My flow', description: '' };
};
const systemText = run => run.roundMessages(0).filter(m => m.role === 'system').map(m => m.content).join('\n');

test('a waiting proposal is the draft the agent sees, marked as staged and not applied', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' }, builderSession: { proposal: staged() },
        message: 'yes, apply it', rounds: [{ text: 'Press Apply on the proposal card.' }] });
    const text = systemText(run);
    assert.match(text, /Proposed/);
    assert.match(text, /STAGED, NOT APPLIED/);
    assert.match(text, /Update Proposed/);
    assert.match(text, /press Apply/);
    // Nothing applied by the chat "yes"; the same proposal still waits.
    assert.equal(run.persists.length, 0);
    assert.equal(run.last('proposal_preview').id, 'prop1');
    assert.equal(run.storedSessions.at(-1).payload.proposal.id, 'prop1');
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
});

test('a follow-up change adds to the waiting proposal, against the live base, with a staged status', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' }, builderSession: { proposal: staged() },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] }), call('builder_summarise')] }, { text: 'Staged both.' }],
        tools: {
            builder_add_steps: (_args, wrap) => { wrap.def.steps.push({ id: 's2', type: 'set', label: 'Email totals' }); return { ok: true }; },
            builder_summarise: (_args, wrap) => ({ summary: wrap.def.steps.map(s => s.label).join(', ') }),
        } });
    const [add, read] = run.dataOf('tool_call');
    assert.equal(add.result.changeStatus, 'staged');
    assert.match(add.result._status, /Apply/);
    assert.equal(read.result.summary, 'Proposed, Email totals');
    assert.equal(read.result.draftView, 'staged');
    const proposal = run.last('proposal_preview');
    assert.notEqual(proposal.id, 'prop1');
    assert.deepEqual(proposal.definition.steps.map(s => s.label), ['Proposed', 'Email totals']);
    assert.deepEqual(proposal.baseDefinition, definition);
    assert.equal(run.persists.length, 0);
});

test('a refused change says nothing changed', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 'nope' })] }, { text: 'Could not.' }],
        tools: { builder_update_step: () => ({ error: 'Unknown step nope.' }) } });
    assert.equal(run.first('tool_call').result.changeStatus, 'rejected');
});

test('a proposal whose base is no longer the live draft is not offered as pending', async () => {
    const old = staged();
    old.baseDefinition.steps[0].label = 'Something else';
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' }, builderSession: { proposal: old },
        rounds: [{ text: 'Nothing staged.' }] });
    assert.doesNotMatch(systemText(run), /STAGED, NOT APPLIED/);
    assert.equal(run.has('proposal_preview'), false);
    assert.equal(run.storedSessions.at(-1).payload.proposal, null);
});

test('the user\'s Apply or Discard reaches the agent on its next turn, once', async () => {
    const applied = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        builderSession: { reviewOutcome: { kind: 'proposal', id: 'prop1', status: 'applied' } }, rounds: [{ text: 'Done.' }] });
    assert.match(systemText(applied), /APPLIED your last proposal/);
    assert.equal(applied.storedSessions.at(-1).payload.reviewOutcome, undefined);
    const discarded = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'discuss' },
        builderSession: { reviewOutcome: { kind: 'proposal', id: 'prop1', status: 'discarded' } }, rounds: [{ text: 'Ok.' }] });
    assert.match(systemText(discarded), /DISCARDED your last proposal/);
});

test('discussing keeps a waiting proposal waiting', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'discuss' }, builderSession: { proposal: staged() },
        rounds: [{ text: 'It renames the step.' }] });
    assert.equal(run.storedSessions.at(-1).payload.proposal.id, 'prop1');
});

test('a size-checked build never commits a waiting proposal it did not get approved', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true }, builderSession: { proposal: staged() },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Staged.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].settings = { assignments: [] }; return { ok: true }; } } });
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    assert.equal(run.first('tool_call').result.changeStatus, 'staged');
    assert.equal(run.last('proposal_preview').definition.steps[0].label, 'Proposed');
});

test('a direct build that changes the live draft drops the out-of-date proposal', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build' }, builderSession: { proposal: staged() },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Changed live.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Live'; return { ok: true }; }, builder_finalize: () => ({ error: 'no' }) } });
    assert.match(systemText(run), /LIVE version without it/);
    assert.equal(run.first('tool_call').result.changeStatus, 'applied');
    assert.equal(run.storedSessions.at(-1).payload.proposal, null);
});

// ── Plan first: one question round, then the plan ───────────────────────────
// The owner's loop: the model asked, the user answered, the model asked again,
// and the turn ended on a checklist with no Build button. Rules under test:
// the server remembers it asked (questionsMeta), the plan follows the answers,
// builder_write_plan ends the turn, and the checklist is a build thing.

const ASKED = [{ id: 'q1', prompt: 'Scope?', options: ['All tickets', 'Only open'] }];
const ANSWERS = 'Q: Scope?\nA: All tickets';
const PLAN_ARGS = { title: 'Tidy', goal: 'Keep it simple', steps: ['Rename the step', 'Add a notification'] };
const ASK_AGAIN = (n = 1) => call('builder_ask_questions', { questions: Array.from({ length: n }, (_, i) => ({ prompt: `Again ${i}?`, options: ['a', 'b'] })) });
const lastUser = (run, i) => run.roundMessages(i).at(-1);

test('an answer turn does not offer the questions tool, tells the model to write the plan, and refuses a hallucinated call', async () => {
    const run = await h.run({ draft: draft(), message: ANSWERS, body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { reviewQuestions: ASKED, questionsMeta: { round: 1, planId: null, mode: 'plan' } },
        rounds: [{ toolCalls: [ASK_AGAIN()] }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }] });
    assert.ok(!names(run).includes('builder_ask_questions'));
    assert.ok(names(run).includes('builder_write_plan'));
    assert.match(systemText(run), /Call builder_write_plan now/);
    const refused = run.dataOf('tool_call').find(c => c.name === 'builder_ask_questions');
    assert.match(refused.result.error, /already asked your questions for this plan/);
    assert.equal(run.has('review_questions'), false);
    assert.equal(run.last('review_plan').plan.status, 'review');
});

test('a model that keeps asking and then talks gets exactly one nudge, then writes the plan (the owner\'s loop)', async () => {
    const run = await h.run({ draft: draft(), message: ANSWERS, body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { reviewQuestions: ASKED, questionsMeta: { round: 1, planId: null, mode: 'plan' } },
        rounds: [{ toolCalls: [ASK_AGAIN()] }, { text: 'I will now summarise what I found.' }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }, { text: 'never' }] });
    assert.equal(run.rounds.length, 3, 'refused ask, one prose round, the plan');
    assert.match(lastUser(run, 2).content, /The user answered your questions\. End this turn by CALLING builder_write_plan now/);
    assert.equal(run.roundOptions(2).toolChoice, 'auto', 'a model with thinking is never pinned');
    assert.equal(run.last('review_plan').plan.status, 'review');
    assert.equal(run.has('review_questions'), false);
    assert.equal(run.storedSessions.at(-1).payload.questionsMeta, null, 'the plan closes the cycle');
});

test('on a small model the nudge after the answers pins the tool call', async () => {
    const run = await h.run({ draft: draft(), message: ANSWERS, modelId: 'mistral-small', body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { reviewQuestions: ASKED, questionsMeta: { round: 1, planId: null, mode: 'plan' } },
        rounds: [{ text: 'Let me think about the plan.' }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }] });
    assert.equal(run.roundOptions(0).toolChoice, 'auto');
    assert.equal(run.roundOptions(1).toolChoice, 'required');
    assert.equal(run.last('review_plan').plan.status, 'review');
});

test('a plan turn that ends in prose on a normal request gets one soft nudge and no pin', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ text: 'Here is my plan: rename the step.' }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }] });
    assert.equal(run.rounds.length, 2);
    assert.match(lastUser(run, 1).content, /Plan first: if the user asked for a change or a new automation, end this turn by calling builder_write_plan/);
    assert.equal(run.roundOptions(0).toolChoice, 'auto');
    assert.equal(run.roundOptions(1).toolChoice, 'auto');
    assert.equal(run.last('review_plan').plan.status, 'review');
});

test('a plan turn where the user only asked something may stay prose; an empty reply to the nudge is not an error', async () => {
    const run = await h.run({ draft: draft(), message: 'What does the first step do?', body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ text: 'It sets x to 1.' }, {}] });
    assert.equal(run.rounds.length, 2, 'one nudge, no second nudge');
    assert.equal(run.has('error'), false);
    assert.equal(run.has('review_plan'), false);
    assert.equal(run.storedSessions.at(-1).payload.conversation.at(-1).content, 'It sets x to 1.');
    // A second prose reply passes through as well.
    const again = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' }, rounds: [{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }] });
    assert.equal(again.rounds.length, 2);
});

test('builder_write_plan ends the turn: later calls in the same reply are refused and no further round runs', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_write_plan', PLAN_ARGS), ASK_AGAIN(), call('builder_summarise')] }, { text: 'never' }],
        tools: { builder_summarise: () => ({ summary: 'x' }) } });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.has('review_questions'), false);
    const results = run.dataOf('tool_call').map(c => c.result);
    assert.equal(results[0].awaitingApproval, true);
    assert.match(results[1].error, /The plan is written and waits for the user/);
    assert.match(results[2].error, /The plan is written and waits for the user/);
    assert.equal(run.toolCalls.length, 0, 'nothing ran');
});

test('Plan first has no checklist: set_plan is not offered, a call is refused, summarise ticks nothing, the turn starts with an empty list', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { todos: [{ text: 'Wait for approval', done: false }, { text: 'Summarise the changes', done: false }] },
        rounds: [{ toolCalls: [call('builder_set_plan', { todos: [{ text: 'Inspect' }] }), call('builder_summarise')] }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }],
        tools: { builder_summarise: () => ({ summary: 'x' }) } });
    assert.ok(!names(run).includes('builder_set_plan'));
    assert.deepEqual(run.dataOf('plan')[0], { todos: [] }, 'the stale list from an earlier turn is cleared first');
    assert.match(run.dataOf('tool_call')[0].result.error, /In Plan first the plan is builder_write_plan; the checklist is only for building/);
    assert.ok(run.dataOf('plan').every(p => p.todos.length === 0), 'nothing ticked or spun');
    assert.deepEqual(run.storedSessions.at(-1).payload.todos, []);
    // The worked build examples are not shown in a planning turn, and are in a build.
    const examples = (r) => r.roundMessages(0).some(m => (m.tool_calls || []).some(tc => /^ex_/.test(tc.id)));
    assert.equal(examples(run), false);
    assert.equal(examples(await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build' } })), true);
    assert.doesNotMatch(systemText(run), /PLAN FIRST\. For any multi-step/);
});

test('the first question round: more than six are cut, the model is told, and the round is remembered', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' }, rounds: [{ toolCalls: [ASK_AGAIN(8)] }, { text: 'never' }] });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.first('review_questions').questions.length, 6);
    assert.equal(run.first('review_questions').planId, null);
    assert.match(run.first('tool_call').result._note, /2 question\(s\) were not shown \(limit 6\)/);
    assert.deepEqual(run.storedSessions.at(-1).payload.questionsMeta, { round: 1, planId: null, mode: 'plan' });
    assert.equal(run.storedSessions.at(-1).payload.reviewQuestions.length, 6);
    // …and a call with nothing usable says what a call looks like.
    const bad = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' }, rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'x', options: ['one'] }] })] }, { toolCalls: [call('builder_write_plan', PLAN_ARGS)] }] });
    assert.match(bad.first('tool_call').result.error, /Provide 1–6 questions, each with 2–4 short answers/);
});

test('the round count survives a prose turn, resets with a plan or a rejected plan, and a new cycle may ask again', async () => {
    const meta = { round: 1, planId: null, mode: 'plan' };
    const prose = await h.run({ draft: draft(), message: 'What does it do?', body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { questionsMeta: meta }, rounds: [{ text: 'It sets x.' }, {}] });
    assert.ok(!names(prose).includes('builder_ask_questions'), 'still closed after a prose turn in between');
    assert.deepEqual(prose.storedSessions.at(-1).payload.questionsMeta, meta);

    const rejected = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { questionsMeta: meta, reviewOutcome: { kind: 'plan', id: 'p1', status: 'rejected' } }, rounds: [{ toolCalls: [ASK_AGAIN()] }] });
    assert.ok(names(rejected).includes('builder_ask_questions'), 'a rejected plan opens a new cycle');
    assert.equal(rejected.has('review_questions'), true);

    const built = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { questionsMeta: meta, reviewPlan: { id: 'p1', version: 1, status: 'built', title: 't', steps: ['x'] } }, rounds: [{ text: 'Ok.' }, {}] });
    assert.ok(names(built).includes('builder_ask_questions'), 'a built plan opens a new cycle');
});

test('a table choice is consent, not clarification: it is allowed after the round is spent', async () => {
    const tables = [{ id: 'tbl_a', key: 'facturen', name: 'Facturen', canWrite: true }];
    const run = await h.run({ draft: draft(), message: ANSWERS, datatables: tables, body: { automationId: 'a1', workMode: 'plan' },
        builderSession: { reviewQuestions: ASKED, questionsMeta: { round: 1, planId: null, mode: 'plan' } },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Which table?', datatableIds: ['tbl_a'] }] })] }] });
    assert.equal(run.first('review_questions').questions[0].prompt, 'Which table?');
    assert.equal(run.first('review_questions').questions[0].choice, undefined, 'choice stays on the server');
});

test('a typed "yes, build it" builds nothing: the model is told only the button builds, and mutations are refused', async () => {
    const plan = { id: 'p1', version: 2, status: 'review', title: 't', goal: 'g', steps: ['Rename'], baseDefinition: definition };
    const run = await h.run({ draft: draft(), message: 'Ja, bouw het plan', body: { automationId: 'a1', workMode: 'plan' }, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Press Build this plan.' }] });
    assert.ok(!names(run).includes('builder_update_step'));
    assert.match(run.dataOf('tool_call')[0].result.error, /not permitted in plan mode/);
    assert.match(systemText(run), /PLAN v2 WAITS FOR APPROVAL\. Only the user's Build this plan button builds it/);
    assert.equal(run.persists.length, 0);
});

// ── The approved build ──────────────────────────────────────────────────────

const approved = (extra = {}) => ({ id: 'p1', version: 1, status: 'review', title: 'Tidy', goal: 'g', steps: ['Rename the step', 'Add a notification'], baseDefinition: definition, ...extra });
const buildBody = { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' };

test('an approved build gets the plan\'s steps as its checklist; a rewrite is ignored, markDone ticks', async () => {
    const run = await h.run({ draft: draft(), body: buildBody,
        builderSession: { reviewPlan: approved(), todos: [{ text: 'Wait for approval before touching anything', done: false }] },
        rounds: [{ toolCalls: [call('builder_set_plan', { todos: [{ text: 'My own list' }] })] }, { toolCalls: [call('builder_set_plan', { markDone: [0] })] }, { text: 'Working on it.' }, { text: 'Still working.' }] });
    const plans = run.dataOf('plan');
    assert.deepEqual(plans[0].todos, [{ text: 'Rename the step', done: false }, { text: 'Add a notification', done: false }], 'seeded from the plan, the plan-turn todo is gone');
    const [rewrite, tick] = run.dataOf('tool_call').map(c => c.result);
    assert.match(rewrite._note, /only markDone is applied/);
    assert.deepEqual(rewrite.todos.map(t => t.text), ['Rename the step', 'Add a notification']);
    assert.deepEqual(tick.todos.map(t => t.done), [true, false]);
    assert.match(systemText(run), /APPROVED this plan: build it now/);
});

test('a build that ends with open steps is nudged once, and stays "building" so the follow-up continues the same plan', async () => {
    const run = await h.run({ draft: draft(), body: buildBody, builderSession: { reviewPlan: approved() },
        rounds: [{ text: 'I cannot do that.' }, { text: 'Still blocked.' }] });
    assert.equal(run.rounds.length, 2);
    assert.match(lastUser(run, 1).content, /These steps are still open: 0\) Rename the step; 1\) Add a notification/);
    assert.equal(run.last('review_plan').plan.status, 'building');
    const stored = run.storedSessions.at(-1).payload;
    assert.equal(stored.reviewPlan.status, 'building');
    assert.equal(stored.questionsMeta, null);

    // The follow-up goes on with the same plan, in whatever mode the composer is in.
    const next = await h.run({ draft: draft(), message: 'continue', body: { automationId: 'a1', workMode: 'build', approvedPlanId: 'p1' }, builderSession: stored,
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Done.' }],
        tools: { builder_update_step: () => ({ ok: true }) } });
    assert.equal(next.has('error'), false);
    assert.ok(next.toolCalls.some(c => c.name === 'builder_update_step'));
    assert.ok(next.roundMessages(0).some(m => m.content?.includes('Follow this approved plan')));
    assert.deepEqual(next.dataOf('plan')[0].todos, [{ text: 'Rename the step', done: false }, { text: 'Add a notification', done: false }]);
});

test('a plan being built survives a canvas edit between turns; a plan under review does not', async () => {
    const edited = () => { const d = draft(); d.definition.steps[0].label = 'Edited by hand'; return d; };
    const building = await h.run({ draft: edited(), message: 'continue', body: buildBody, builderSession: { reviewPlan: approved({ status: 'building' }) }, rounds: [{ text: 'Ok.' }, { text: 'Ok.' }] });
    assert.equal(building.has('error'), false);
    const review = await h.run({ draft: edited(), body: buildBody, builderSession: { reviewPlan: approved() } });
    assert.match(review.first('error').error, /no longer available/);
});

test('the plan is "built" when its steps are all done, and the next planning turn starts clean', async () => {
    const run = await h.run({ draft: draft(), body: buildBody, builderSession: { reviewPlan: approved({ steps: ['Rename the step'] }) },
        rounds: [{ toolCalls: [call('builder_set_plan', { markDone: [0] })] }, { text: 'Plan complete.' }] });
    assert.equal(run.rounds.length, 2, 'no nudge: nothing is open');
    assert.equal(run.last('review_plan').plan.status, 'built');
    const next = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' }, builderSession: run.storedSessions.at(-1).payload, rounds: [{ toolCalls: [ASK_AGAIN()] }] });
    assert.ok(names(next).includes('builder_ask_questions'));
    assert.deepEqual(next.dataOf('plan')[0], { todos: [] });
});

test('a question during an approved build pauses the plan, and answering it continues the build', async () => {
    const run = await h.run({ draft: draft(), body: buildBody, builderSession: { reviewPlan: approved() },
        rounds: [{ toolCalls: [ASK_AGAIN()] }, { text: 'never' }] });
    assert.equal(run.last('review_plan').plan.status, 'paused');
    assert.equal(run.first('review_questions').planId, 'p1');
    const stored = run.storedSessions.at(-1).payload;
    assert.deepEqual(stored.questionsMeta, { round: 0, planId: 'p1', mode: 'build' });

    const answer = 'Q: Again 0?\nA: a';
    const next = await h.run({ draft: draft(), message: answer, body: buildBody, builderSession: stored,
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Done.' }],
        tools: { builder_update_step: () => ({ ok: true }) } });
    assert.ok(names(next).includes('builder_update_step'), 'a build, not a planning turn');
    assert.ok(next.roundMessages(0).some(m => m.content?.includes('Follow this approved plan')));
    assert.match(systemText(next), /answered the 1 question you asked/);
    assert.match(systemText(next), /Continue the approved plan/);
    assert.equal(next.has('review_questions'), false);
});

test('a plan with a removal and an inline step: the build turn may fold a flowlet in, and it is staged in approve mode', async () => {
    const plan = approved({ steps: ['Inline the Enrich flowlet into the main flow'] });
    const run = await h.run({ draft: draft(), body: buildBody, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_inline_layer', { stepId: 'cl1' })] }, { text: 'Done.' }],
        tools: { builder_inline_layer: () => ({ inlined: { layerKey: 'enrich' } }), builder_finalize: () => ({ error: 'no' }) } });
    assert.ok(names(run).includes('builder_inline_layer'));
    assert.equal(run.first('tool_call').result.changeStatus, 'applied');
    const stagedRun = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_inline_layer', { stepId: 'cl1' })] }, { text: 'Proposed.' }],
        tools: { builder_inline_layer: (_a, wrap) => { wrap.def.steps[0].label = 'Inlined'; return { inlined: {} }; } } });
    assert.equal(stagedRun.first('tool_call').result.changeStatus, 'staged');
    assert.equal(stagedRun.persists.length, 0);
});
