/**
 * The plan checklist ticks from the tool calls, not from the model's goodwill.
 *
 * The fixture is the exact 9-item plan and step labels from the owner's build
 * on 2026-09-11, which sat at 0/9 while the routine was fully built.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/automationBuilder/planProgress.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { inferPlanProgress } = require('./planProgress');

const PLAN = [
    'Confirm manual trigger (already set)',
    'List files in /Invoices',
    'Read each file (forEach)',
    'AI step: extract vendor/amount/dueDate per file (chained forEach)',
    'Build rows array via set step',
    'Create/append spreadsheet with invoice rows',
    'Wire error branches to a Nextcloud notification',
    'Dry run and fix',
    'Finalize',
].map(text => ({ text, done: false }));
const fresh = () => PLAN.map(t => ({ ...t }));
const mark = (todos, idx) => { for (const i of idx) todos[i].done = true; return todos; };

test('the trigger item ticks when the trigger is proposed', () => {
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_propose_trigger', args: { kind: 'manual' }, result: { trigger: { kind: 'manual' } } }), [0]);
});

test('one batch that builds the chain ticks every step item it covers — and only those', () => {
    // The REAL batch shape: applyAddSteps echoes {tempId?, id, type, tool?}
    // per entry — the label and the forEach live in the entry's spec.
    const args = { steps: [
        { tempId: 'list', type: 'integration_action', spec: { tool: 'nextcloud_list_files', label: 'List files in /Invoices' } },
        { tempId: 'read', type: 'integration_action', spec: { tool: 'nextcloud_read_file', label: 'Read each file', forEach: { overRef: 'steps.$list.output.items' } } },
        { tempId: 'ai', type: 'ai_step', spec: { prompt: 'x', label: 'Extract invoice details', forEach: { overRef: 'steps.$read.output.results' } } },
        { tempId: 's1', type: 'set', spec: { fields: {}, label: 'Build rows array' } },
        { tempId: 'save', type: 'integration_action', spec: { tool: 'nextcloud_create_spreadsheet', label: 'Save invoice details to spreadsheet' } },
    ] };
    const result = { added: [
        { tempId: 'list', id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files' },
        { tempId: 'read', id: 'a2', type: 'integration_action', tool: 'nextcloud_read_file' },
        { tempId: 'ai', id: 'ai', type: 'ai_step' },
        { tempId: 's1', id: 's1', type: 'set' },
        { tempId: 'save', id: 'a3', type: 'integration_action', tool: 'nextcloud_create_spreadsheet' },
    ] };
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_add_steps', args, result }), [1, 2, 3, 4, 5]);
});

test('the default invoice build — list, read, extract, save in one batch — ticks every step item, including the two with no tool name', () => {
    // Measured: with only the type word to match on, 'data extraction' never
    // met 'Extract invoice details' and 2 of 4 items stayed open.
    const plan = ['List files in /Invoices-Test', 'Read each file', 'Extract invoice details', 'Append one row per invoice to Facturen'].map(text => ({ text, done: false }));
    const args = { steps: [
        { tempId: 'list', type: 'integration_action', spec: { tool: 'nextcloud_list_files', label: 'List files in /Invoices-Test' } },
        { tempId: 'read', type: 'integration_action', spec: { tool: 'nextcloud_read_file', label: 'Read each file', forEach: { overRef: 'steps.$list.output.items', itemVar: 'f' } } },
        { tempId: 'extract', type: 'data_extraction', spec: { label: 'Extract invoice details', source: { kind: 'ref', path: 'loop.r.output.content' }, fields: [], forEach: { overRef: 'steps.$read.output.results', itemVar: 'r' } } },
        { tempId: 'save', type: 'datatable', spec: { label: 'Append one row per invoice to Facturen', op: 'add_row', datatableId: 'tbl_1', forEach: { overRef: 'steps.$extract.output.results', itemVar: 'x' } } },
    ] };
    const result = { added: [
        { tempId: 'list', id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files' },
        { tempId: 'read', id: 'a2', type: 'integration_action', tool: 'nextcloud_read_file' },
        { tempId: 'extract', id: 'ex1', type: 'data_extraction' },
        { tempId: 'save', id: 'dt1', type: 'datatable' },
    ] };
    assert.deepStrictEqual(inferPlanProgress(plan, { name: 'builder_add_steps', args, result }), [0, 1, 2, 3]);
    // A partial batch: chatStream hands over args.steps sliced to failedIndex
    // and only the built entries — still index-aligned.
    const partial = inferPlanProgress(plan, { name: 'builder_add_steps', args: { steps: args.steps.slice(0, 3) }, result: { added: result.added.slice(0, 3) } });
    assert.deepStrictEqual(partial, [0, 1, 2]);
    // Without the specs (a caller that passes no args) the two tool-less
    // entries cannot be evidenced — pinned so the merge is known to matter.
    assert.deepStrictEqual(inferPlanProgress(plan, { name: 'builder_add_steps', args: {}, result }), [0, 1]);
});

test('the list step alone does NOT tick "Read each file" — one shared word is not evidence', () => {
    const result = { added: { id: 'a1', type: 'integration_action', tool: 'nextcloud_list_files', label: 'List files in /Invoices' } };
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_add_action', args: {}, result }), [1]);
});

test('an error-branch wire ticks the error-handling item; a notification appended with branch:"error" does too', () => {
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_wire_error_branch', args: {}, result: { wired: { from: 'a', to: 'b', label: 'on_error' } } }), [6]);
    const r = inferPlanProgress(fresh(), { name: 'builder_add_action', args: { branch: 'error' }, result: { added: { id: 'n', type: 'integration_action', tool: 'nextcloud_notifications_send', label: 'Notify on failure' } } });
    assert.ok(r.includes(6));
});

test('a clean dry-run ticks the dry-run item; a failed one does not', () => {
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_request_dry_run', args: {}, result: { run: { status: 'success' }, steps: [{ status: 'success' }] } }), [7]);
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_request_dry_run', args: {}, result: { run: { status: 'failed' }, steps: [{ error: 'boom' }] } }), []);
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_request_dry_run', args: {}, result: { run: { status: 'success' }, steps: [{ error: 'one step broke' }] } }), []);
});

test('finalize ticks everything still open', () => {
    const todos = mark(fresh(), [0, 1, 2]);
    assert.deepStrictEqual(inferPlanProgress(todos, { name: 'builder_finalize', args: {}, result: { automation: { id: 'x' } } }), [3, 4, 5, 6, 7, 8]);
});

test('already-done items are never returned again, and nothing ticks on an error result', () => {
    const todos = mark(fresh(), [0]);
    assert.deepStrictEqual(inferPlanProgress(todos, { name: 'builder_propose_trigger', args: {}, result: { trigger: {} } }), []);
    assert.deepStrictEqual(inferPlanProgress(fresh(), { name: 'builder_add_steps', args: {}, result: { error: 'nope' } }), []);
    assert.deepStrictEqual(inferPlanProgress([], { name: 'builder_finalize', args: {}, result: { automation: {} } }), []);
});

test('a step whose label copies a different item verbatim ticks that item, not its neighbours', () => {
    const plan = [{ text: 'Search Gmail for invoices', done: false }, { text: 'Summarise the results', done: false }, { text: 'Send the digest', done: false }];
    const r = inferPlanProgress(plan, { name: 'builder_add_ai_step', args: {}, result: { added: { id: 'ai', type: 'ai_step', label: 'Summarise the results' } } });
    assert.deepStrictEqual(r, [1]);
});
