'use strict';

/**
 * The tool sets of the four work modes, as pure functions.
 *
 * The route test (chatStream.workMode.test.js) drives whole turns; this file
 * pins the rules underneath so a change to a set cannot slip through a turn
 * that happens not to call the tool:
 *   - a tool whose gate NAMES another tool is offered in every mode that offers
 *     the gated tool (the fill_document / builder_read_document deadlock),
 *   - the dry run is a staged check in approve and plan, never in discuss,
 *   - builder_remove_step comes back for an approved plan only, and only for the
 *     steps that plan names.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/workMode.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    toolAllowed, planMentionsRemoval, planCoversRemoval, resolveRemovalTarget, modeInstruction, previewRefusal, MODES,
    writePlan, writeQuestions, stripListMarker, QUESTIONS_TOOL, PLAN_TOOL, MAX_QUESTIONS, MAX_OPTIONS,
    TABLE_CONSENT_RULE, planDatatableEntry, changedSteps, withChangeStatus, reviewStatusNote, questionStatusNote,
} = require('./workMode');
const { TOOL_SCHEMAS } = require('../../../automation/builderTools');

const ALL = TOOL_SCHEMAS.map(t => t.function.name);

test('every mode that can build a fill_document step can also read and search documents', () => {
    for (const mode of MODES) {
        if (!toolAllowed('builder_add_fill_document', mode)) continue;
        assert.ok(toolAllowed('builder_read_document', mode), `builder_read_document in ${mode}`);
        assert.ok(toolAllowed('builder_search_documents', mode), `builder_search_documents in ${mode}`);
    }
});

test('the document tools are plain reads: offered in every mode, including discuss and plan', () => {
    for (const mode of MODES) {
        assert.ok(toolAllowed('builder_search_documents', mode), `search in ${mode}`);
        assert.ok(toolAllowed('builder_read_document', mode), `read in ${mode}`);
    }
});

test('the dry run is a staged check: approve and plan yes, discuss no', () => {
    assert.equal(toolAllowed('builder_request_dry_run', 'approve'), true);
    assert.equal(toolAllowed('builder_request_dry_run', 'plan'), true);
    assert.equal(toolAllowed('builder_request_dry_run', 'build'), true);
    assert.equal(toolAllowed('builder_request_dry_run', 'discuss'), false);
});

test('a preview still cannot finalize or spend a flowlet sub-agent', () => {
    for (const name of ['builder_finalize', 'builder_generate_layer', 'builder_generate_layers']) {
        for (const mode of ['discuss', 'approve', 'plan']) assert.equal(toolAllowed(name, mode), false, `${name} in ${mode}`);
    }
});

test('builder_create_datatable: allowed in approve (it stages) and build, refused in plan and discuss', () => {
    assert.equal(toolAllowed('builder_create_datatable', 'approve'), true);
    assert.equal(toolAllowed('builder_create_datatable', 'build'), true);
    assert.equal(toolAllowed('builder_create_datatable', 'plan'), false);
    assert.equal(toolAllowed('builder_create_datatable', 'discuss'), false);
});

test('plan and discuss still change nothing: no mutating tool is allowed there', () => {
    const { MUTATING_TOOLS } = require('../../../automation/builderTools');
    for (const mode of ['discuss', 'plan']) {
        const open = ALL.filter(n => MUTATING_TOOLS.has(n) && toolAllowed(n, mode));
        assert.deepEqual(open, [], `${mode} allows ${open.join(', ')}`);
    }
});

test('remove_step is denied in build unless the turn executes a plan that names a removal', () => {
    assert.equal(toolAllowed('builder_remove_step', 'build'), false);
    assert.equal(toolAllowed('builder_remove_step', 'build', { planAllowsRemoval: true }), true);
    // The option widens only that one tool, and only in build.
    assert.equal(toolAllowed('builder_remove_step', 'approve', { planAllowsRemoval: true }), true, 'approve already stages removals');
    assert.equal(toolAllowed('builder_remove_step', 'plan', { planAllowsRemoval: true }), false);
    assert.equal(toolAllowed('builder_remove_step', 'discuss', { planAllowsRemoval: true }), false);
});

test('planMentionsRemoval reads the plan steps, in English and Dutch, and only the steps', () => {
    assert.equal(planMentionsRemoval({ steps: ['Remove the old totals step'] }), true);
    assert.equal(planMentionsRemoval({ steps: ['Verwijder de stap "Oud"'] }), true);
    assert.equal(planMentionsRemoval({ steps: ['Rename the step'] }), false);
    assert.equal(planMentionsRemoval({ steps: ['Add a step'], tests: ['Check that nothing is removed'] }), false, 'tests are not removals');
    assert.equal(planMentionsRemoval(null), false);
});

test('planCoversRemoval needs one plan line that says remove AND names the step', () => {
    const plan = { steps: ['Remove the "Old totals" step', 'Rename s1 to Intake', 'Delete step s7'] };
    assert.equal(planCoversRemoval(plan, { id: 's2', label: 'Old totals' }), true, 'by label');
    assert.equal(planCoversRemoval(plan, { id: 's7', label: 'x' }), true, 'by id');
    assert.equal(planCoversRemoval(plan, { id: 's1', label: 'Intake' }), false, 'named, but the line renames it');
    assert.equal(planCoversRemoval(plan, { id: 's9', label: 'Other' }), false, 'not named at all');
    assert.equal(planCoversRemoval(plan, { id: 's3', label: 'a' }), false, 'a one-letter label matches nothing by accident');
    assert.equal(planCoversRemoval(plan, null), false);
});

test('planCoversRemoval does not cover a step the same line says to keep', () => {
    const plan = { steps: ['Remove the old Slack ping; Send email stays as is', 'Remove the Archive copy and keep Report', 'Keep Notify, remove Digest'] };
    assert.equal(planCoversRemoval(plan, { id: 'a', label: 'old Slack ping' }), true);
    assert.equal(planCoversRemoval(plan, { id: 'b', label: 'Send email' }), false, 'its own clause says stays');
    assert.equal(planCoversRemoval(plan, { id: 'c', label: 'Archive copy' }), true, 'the removal half of "remove X and keep Y"');
    assert.equal(planCoversRemoval(plan, { id: 'd', label: 'Report' }), false, 'the keep half');
    assert.equal(planCoversRemoval(plan, { id: 'e', label: 'Notify' }), false);
    assert.equal(planCoversRemoval(plan, { id: 'f', label: 'Digest' }), false, 'a clause that keeps anything fails closed');
});

test('planCoversRemoval matches an id or label as a whole phrase only', () => {
    const plan = { steps: ['Delete step x_7', 'Remove the Resend step'] };
    assert.equal(planCoversRemoval(plan, { id: 'x_7', label: 'Q' }), true);
    assert.equal(planCoversRemoval(plan, { id: 'x_71', label: 'Q' }), false, 'x_7 is not inside x_71');
    assert.equal(planCoversRemoval(plan, { id: 's', label: 'Send' }), false, '"Send" is not inside "Resend"');
    assert.equal(planCoversRemoval(plan, { id: 's', label: 'Resend' }), true);
    assert.equal(planCoversRemoval({ steps: ['Remove a+b (old)'] }, { id: 's', label: 'a+b (old)' }), true, 'regex characters in a label are literal');
});

test('resolveRemovalTarget looks in the graph the call changes', () => {
    const def = { trigger: { id: 'trg' }, triggers: [{ id: 'trg2' }], steps: [{ id: 'dup', label: 'Root' }, { id: 'l', type: 'loop', body: [{ id: 'inner', label: 'In loop' }] }],
        layers: { inv: { trigger: { id: 'ltrg' }, steps: [{ id: 'dup', label: 'Flowlet' }, { id: 'x_7', label: 'Only here' }] } } };
    assert.equal(resolveRemovalTarget(def, { stepId: 'dup' }).label, 'Root');
    assert.equal(resolveRemovalTarget(def, { stepId: 'dup', scope: 'inv' }).label, 'Flowlet');
    assert.equal(resolveRemovalTarget(def, { stepId: 'x_7' }), null, 'a flowlet step is not a root step');
    assert.equal(resolveRemovalTarget(def, { stepId: 'x_7', scope: 'inv' }).label, 'Only here');
    assert.equal(resolveRemovalTarget(def, { stepId: 'x_7', scope: 'nope' }), null);
    assert.equal(resolveRemovalTarget(def, { stepId: 'inner' }).label, 'In loop');
    assert.equal(resolveRemovalTarget(def, { stepId: 'trg2' }).id, 'trg2');
    assert.equal(resolveRemovalTarget(def, { stepId: 'ltrg', scope: 'inv' }).id, 'ltrg');
    assert.equal(resolveRemovalTarget(def, {}), null);
});

test('the build instruction mentions the removal exception only when the plan has one', () => {
    assert.doesNotMatch(modeInstruction('build', { steps: ['Rename it'] }), /except a step this approved plan names/);
    assert.match(modeInstruction('build', { steps: ['Remove the old step'] }), /except a step this approved plan names/);
    assert.doesNotMatch(modeInstruction('build', null), /except a step/);
});

test('the approve instruction allows the staged dry run and teaches the staged table and the type change', () => {
    const text = modeInstruction('approve');
    assert.match(text, /builder_request_dry_run runs the STAGED definition without saving it/);
    assert.match(text, /In a preview it is STAGED: you get datatableId "pending:<n>"/);
    assert.match(text, /created only when the user presses Apply; say so, never that it exists/);
    assert.match(text, /builder_replace_step with newType:"datatable"/);
    assert.doesNotMatch(text, /Do not run external actions/, 'the old blanket ban is gone: the dry run simulates them');
});

test('the plan instruction names the read tools and the dry run it now has', () => {
    const text = modeInstruction('plan');
    assert.match(text, /builder_search_documents/);
    assert.match(text, /builder_request_dry_run/);
    assert.match(text, /Never build in this turn/);
});

test('previewRefusal: a table in Plan first points at the plan\'s datatables list, anything else the generic one', () => {
    assert.match(previewRefusal('builder_create_datatable', 'plan'), /Put it in builder_write_plan's "datatables" list/);
    assert.match(previewRefusal('builder_create_datatable', 'discuss'), /not permitted in discuss mode/);
    assert.match(previewRefusal('builder_finalize', 'plan'), /not permitted in plan mode/);
});

test('every mode carries the table consent rule; plan also asks for the datatables list', () => {
    for (const mode of MODES) assert.ok(modeInstruction(mode).includes(TABLE_CONSENT_RULE), mode);
    assert.match(modeInstruction('plan'), /builder_write_plan\.datatables and the existing tables you will use in useDatatables/);
});

test('plan and discuss tell the model not to repeat the questions the card shows', () => {
    for (const mode of ['plan', 'discuss']) {
        const text = modeInstruction(mode);
        assert.match(text, /do NOT write the questions or their options in your message/, mode);
        assert.match(text, /at most one short sentence/, mode);
    }
    assert.match(QUESTIONS_TOOL.function.description, /do NOT repeat them in your message/);
});

test('the plan instruction asks for plain sentences, not numbered steps', () => {
    const text = modeInstruction('plan');
    assert.doesNotMatch(text, /numbered steps/);
    assert.match(text, /without numbering or bullet characters/);
    assert.match(PLAN_TOOL.function.parameters.properties.steps.description, /without numbering/);
});

test('stripListMarker removes a marker followed by a space and nothing else', () => {
    assert.equal(stripListMarker('1. Add a webhook'), 'Add a webhook');
    assert.equal(stripListMarker('2) Call http_request'), 'Call http_request');
    assert.equal(stripListMarker('- Use the finance inbox'), 'Use the finance inbox');
    assert.equal(stripListMarker('* Use it'), 'Use it');
    assert.equal(stripListMarker('\u2022 Use it'), 'Use it');
    assert.equal(stripListMarker('  - 1. nested marker'), 'nested marker');
    assert.equal(stripListMarker('3 retries on failure'), '3 retries on failure');
    assert.equal(stripListMarker('1.5 seconds between calls'), '1.5 seconds between calls');
    assert.equal(stripListMarker('**Bold** first'), '**Bold** first');
    assert.equal(stripListMarker('-1 is the sentinel'), '-1 is the sentinel');
    assert.equal(stripListMarker('1. '), '1.', 'a line that is only a marker is kept rather than emptied');
});

test('writePlan strips numbering and bullets from every section', () => {
    const plan = writePlan({
        title: 'T', goal: 'G',
        steps: ['1. Add a **webhook** trigger', '2) Call `http_request`'],
        assumptions: ['- Finance inbox'], prerequisites: ['* A token'], tests: ['\u2022 Dry run'],
    });
    assert.deepEqual(plan.steps, ['Add a **webhook** trigger', 'Call `http_request`']);
    assert.deepEqual(plan.assumptions, ['Finance inbox']);
    assert.deepEqual(plan.prerequisites, ['A token']);
    assert.deepEqual(plan.tests, ['Dry run']);
});

test('writeQuestions still accepts markdown in a prompt and keeps its length cap', () => {
    const [q] = writeQuestions({ questions: [{ prompt: 'Which **trigger**?', options: ['Webhook', 'Schedule'] }] }).questions;
    assert.equal(q.prompt, 'Which **trigger**?');
    assert.equal(writeQuestions({ questions: [{ prompt: 'x', options: ['only one'] }] }), null);
});


// ── table questions ─────────────────────────────────────────────────────────

const CATALOG = [
    { id: 'tbl_a', key: 'facturen', name: 'Facturen', canWrite: true },
    { id: 'tbl_b', key: 'klanten', name: 'Klanten', canWrite: true },
    { id: 'tbl_c', key: 'facturen_2', name: 'Facturen', canWrite: false },
    { id: 'pending:1', key: 'nieuw', name: 'Nieuw', canWrite: true, pending: true },
];

test('writeQuestions with datatableIds builds table options plus the create option and keeps choice server-side', () => {
    const [q] = writeQuestions({ questions: [{ prompt: 'Which table?', datatableIds: ['tbl_b', 'tbl_a'], createLabel: 'Maak een nieuwe tabel' }] }, { datatables: CATALOG }).questions;
    assert.deepEqual(q.options, ['Klanten', 'Facturen', 'Maak een nieuwe tabel']);
    assert.deepEqual(q.choice, { kind: 'datatable', access: 'write', options: [
        { label: 'Klanten', datatableId: 'tbl_b' }, { label: 'Facturen', datatableId: 'tbl_a' }, { label: 'Maak een nieuwe tabel', create: true },
    ] });
});

test('writeQuestions: colliding names are told apart by key, unknown and pending ids are dropped, a default create label is used', () => {
    const [q] = writeQuestions({ questions: [{ prompt: 'Which?', datatableIds: ['tbl_a', 'tbl_c', 'tbl_nope', 'pending:1'] }] }, { datatables: CATALOG }).questions;
    assert.deepEqual(q.options, ['Facturen (facturen)', 'Facturen (facturen_2)', 'Create a new table']);
    assert.equal(q.choice.access, 'read', 'a read-only table in the list makes it a read question');
});

test('writeQuestions: fewer than 2 options, more than 4, or no catalog make the call unusable', () => {
    assert.equal(writeQuestions({ questions: [{ prompt: 'x', datatableIds: ['tbl_nope'] }] }, { datatables: CATALOG }), null);
    assert.equal(writeQuestions({ questions: [{ prompt: 'x', datatableIds: ['tbl_a'] }] }, { datatables: null }), null);
    const many = ['a', 'b', 'c', 'd'].map((k) => ({ id: `tbl_${k}`, key: k, name: k.toUpperCase().repeat(3), canWrite: true }));
    assert.equal(writeQuestions({ questions: [{ prompt: 'x', datatableIds: many.map((m) => m.id) }] }, { datatables: many }), null, '4 tables + create = 5 options');
});

test('writeQuestions: questions without datatableIds behave as before, and the schema allows both shapes', () => {
    const [q] = writeQuestions({ questions: [{ prompt: 'Which trigger?', options: ['Webhook', 'Schedule'] }] }, { datatables: CATALOG }).questions;
    assert.equal(q.choice, undefined);
    assert.equal(writeQuestions({ questions: [{ prompt: 'x' }] }), null, 'neither options nor datatableIds');
    const item = QUESTIONS_TOOL.function.parameters.properties.questions.items;
    assert.deepEqual(item.required, ['prompt']);
    assert.ok(item.properties.datatableIds && item.properties.createLabel && item.properties.options);
    assert.match(QUESTIONS_TOOL.function.description, /pass datatableIds .* and createLabel instead of options/);
});

// ── plan tables ─────────────────────────────────────────────────────────────

test('writePlan normalises datatables, resolves useDatatables and drops what does not hold', () => {
    const plan = writePlan({
        title: 'T', goal: 'G', steps: ['Do it'],
        datatables: [
            { name: 'Facturen nieuw', description: 'x', fields: [{ name: 'Datum', type: 'date' }, { name: 'Excl. btw', type: 'currency' }] },
            { name: 'facturen nieuw', fields: [{ name: 'Dup', type: 'text' }] },
            { name: '', fields: [{ name: 'A', type: 'text' }] },
            { name: 'Leeg', fields: [] },
        ],
        useDatatables: ['tbl_b', 'Klanten', 'tbl_nope', 'pending:1'],
    }, null, { datatables: CATALOG });
    assert.deepEqual(plan.datatables, [{ name: 'Facturen nieuw', description: 'x', fields: [{ key: 'datum', name: 'Datum', type: 'date' }, { key: 'excl_btw', name: 'Excl. btw', type: 'number' }] }]);
    assert.deepEqual(plan.useDatatables, [{ id: 'tbl_b', key: 'klanten', name: 'Klanten' }]);
    assert.equal(writePlan({ title: 'T', goal: 'G', steps: ['Do it'] }).datatables, undefined, 'no tables, no key');
    assert.equal(PLAN_TOOL.function.parameters.properties.datatables.maxItems, 5);
    assert.ok(PLAN_TOOL.function.parameters.properties.useDatatables);
});

test('planDatatableEntry matches by normalised name', () => {
    const plan = { datatables: [{ name: 'Facturen nieuw', fields: [] }] };
    assert.equal(planDatatableEntry(plan, ' facturen-nieuw ').name, 'Facturen nieuw');
    assert.equal(planDatatableEntry(plan, 'Klanten'), null);
    assert.equal(planDatatableEntry({}, 'x'), null);
});

// ── notes and statuses ──────────────────────────────────────────────────────

test('changedSteps lists a table to create after the step changes', () => {
    const changes = changedSteps({ steps: [] }, { steps: [{ id: 'a', type: 'set', label: 'Set' }] }, [{ ref: 'pending:1', name: 'Facturen' }]);
    assert.deepEqual(changes, ['Add Set', 'Create table "Facturen"']);
});

test('withChangeStatus marks a staged table, and says in a buffered build that it always waits for Apply', () => {
    const direct = withChangeStatus({ datatableId: 'pending:1', staged: true }, { isolated: true, buffered: false });
    assert.equal(direct.changeStatus, 'staged');
    assert.match(direct._status, /Staged, not applied/);
    const buffered = withChangeStatus({ datatableId: 'pending:1', staged: true }, { isolated: true, buffered: true });
    assert.equal(buffered._status, "Staged: a new table always waits for the user's Apply.");
    assert.equal(withChangeStatus({ error: 'x', staged: true }, { isolated: true }).changeStatus, 'rejected');
});

const STAGED = { ref: 'pending:1', key: 'facturen', name: 'Facturen', fields: [{ key: 'datum', type: 'date' }, { key: 'bedrag', type: 'number' }] };

test('reviewStatusNote: staged tables, with the ids to use, appear in the pending note', () => {
    const note = reviewStatusNote({ pending: { id: 'p', definition: { steps: [] }, baseDefinition: { steps: [] }, pendingDatatables: [STAGED] }, isolated: true });
    assert.match(note, /STAGED, NOT APPLIED: a proposal waits for the user \(Create table "Facturen"\)/);
    assert.match(note, /STAGED TABLES \(not created yet; created when the user presses Apply; use these ids\): pending:1 · key facturen · "Facturen" · columns: datum date, bedrag number\./);
});

test('reviewStatusNote: applied tables, and the flow-not-saved variant', () => {
    const outcome = { kind: 'proposal', status: 'applied', datatables: [{ ref: 'pending:1', id: 'tbl_x', key: 'facturen', name: 'Facturen' }] };
    const saved = reviewStatusNote({ outcome, liveDef: { steps: [{ id: 's', type: 'datatable', datatableId: 'tbl_x' }] } });
    assert.match(saved, /The table "Facturen" \(id tbl_x, key facturen\) was created on Apply\./);
    assert.doesNotMatch(saved, /was not saved/);
    const lost = reviewStatusNote({ outcome, liveDef: { steps: [] } });
    assert.match(lost, /The flow that used them was not saved; rebuild those steps on these ids\./);
});

test('reviewStatusNote: the table the user chose and the request for a new one', () => {
    const note = reviewStatusNote({ choice: { approvedIds: ['tbl_a'], tables: [{ id: 'tbl_a', key: 'facturen', name: 'Facturen' }], createFor: ['Which table for the invoices?'] } });
    assert.match(note, /The user chose the existing table "Facturen" \(tbl_a, key facturen\)\. Bind the step to it\./);
    assert.match(note, /The user wants a NEW table for: Which table for the invoices\?\. Create it with builder_create_datatable\./);
});

// ── one question round, everything asked at once ────────────────────────────

const q = (n, extra = {}) => ({ prompt: `Question ${n}?`, options: ['Yes', 'No'], ...extra });

test('writeQuestions accepts the limit and cuts the rest instead of rejecting the call', () => {
    assert.equal(MAX_QUESTIONS, 6);
    assert.equal(QUESTIONS_TOOL.function.parameters.properties.questions.maxItems, 6);
    const six = writeQuestions({ questions: [1, 2, 3, 4, 5, 6].map(n => q(n)) });
    assert.equal(six.questions.length, 6);
    assert.equal(six.dropped, 0);
    const eight = writeQuestions({ questions: [1, 2, 3, 4, 5, 6, 7, 8].map(n => q(n)) });
    assert.equal(eight.questions.length, 6);
    assert.equal(eight.dropped, 2);
    assert.deepEqual(eight.questions.map(x => x.prompt), [1, 2, 3, 4, 5, 6].map(n => `Question ${n}?`));
});

test('writeQuestions drops a malformed question and keeps the rest; null only when none is usable', () => {
    const r = writeQuestions({ questions: [q(1), { prompt: 7, options: ['a', 'b'] }, { prompt: 'One answer?', options: ['only'] }, { options: ['a', 'b'] }, q(2)] });
    assert.deepEqual(r.questions.map(x => x.prompt), ['Question 1?', 'Question 2?']);
    assert.equal(r.dropped, 0, 'malformed questions are not "cut": the model is told only about the limit');
    assert.equal(writeQuestions({ questions: [{ prompt: 'x', options: ['one'] }, null] }), null);
    assert.equal(writeQuestions({ questions: [] }), null);
    assert.equal(writeQuestions({}), null);
});

test('writeQuestions cuts options at the limit, strips the recommended marker and list markers, removes duplicates', () => {
    assert.equal(MAX_OPTIONS, 4);
    const r = writeQuestions({ questions: [
        { prompt: '1. Which inbox?', options: ['Finance (recommended)', 'Sales (aanbevolen)', '- Support (Suggested)', 'Ops', 'Fifth'] },
        { prompt: 'which INBOX?', options: ['a', 'b'] },
        { prompt: 'Retries?', options: ['3 retries (voorgesteld)', 'None'], header: '  Retry   policy for all  ' },
    ] });
    assert.deepEqual(r.questions.map(x => x.prompt), ['Which inbox?', 'Retries?'], 'the case-folded duplicate is gone');
    assert.deepEqual(r.questions[0].options, ['Finance', 'Sales', 'Support', 'Ops']);
    assert.deepEqual(r.questions[1].options, ['3 retries', 'None']);
    assert.equal(r.questions[1].header, 'Retry policy for all');
    assert.equal(r.questions[0].header, undefined);
    assert.equal(writeQuestions({ questions: [q(1, { header: 'x'.repeat(80) })] }).questions[0].header.length, 40);
});

test('writeQuestions passes a table question through with its server-only choice, next to plain ones', () => {
    const r = writeQuestions({ questions: [q(1), { prompt: 'Which table?', datatableIds: ['tbl_a'], header: 'Table' }, { prompt: 'Broken table?', datatableIds: ['tbl_nope'] }] }, { datatables: CATALOG });
    assert.equal(r.questions.length, 2, 'the unusable table question is dropped, the call survives');
    assert.equal(r.questions[1].choice.kind, 'datatable');
    assert.equal(r.questions[1].header, 'Table');
});

test('Plan first has no checklist: set_plan is offered in approve and build only, and refused with the reason elsewhere', () => {
    for (const mode of ['plan', 'discuss']) {
        assert.equal(toolAllowed('builder_set_plan', mode), false, mode);
        assert.match(previewRefusal('builder_set_plan', mode), /In Plan first the plan is builder_write_plan; the checklist is only for building/);
    }
    for (const mode of ['approve', 'build']) assert.equal(toolAllowed('builder_set_plan', mode), true, mode);
    assert.equal(toolAllowed('builder_write_plan', 'plan'), true);
});

test('builder_inline_layer is a staged change in approve mode, allowed in build, and never in plan or discuss', () => {
    assert.equal(toolAllowed('builder_inline_layer', 'approve'), true);
    assert.equal(toolAllowed('builder_inline_layer', 'build'), true);
    assert.equal(toolAllowed('builder_inline_layer', 'plan'), false);
    assert.equal(toolAllowed('builder_inline_layer', 'discuss'), false);
});

test('the plan instruction asks for ALL questions in ONE call, forbids the checklist and names the two ways to end', () => {
    const text = modeInstruction('plan');
    assert.match(text, /ask ALL your questions in ONE builder_ask_questions call/);
    assert.match(text, /Do not call builder_set_plan/);
    assert.match(text, /exactly one of: builder_ask_questions or builder_write_plan/);
    assert.match(text, /collect EVERY open question/);
});

test('an approved build says approval is given, and that the checklist is the plan', () => {
    const text = modeInstruction('build', { id: 'p1', steps: ['Do it'] });
    assert.match(text, /APPROVED this plan: build it now/);
    assert.match(text, /Follow this approved plan/);
    assert.match(text, /mark them done with builder_set_plan\(\{markDone\}\) and do not replace the list/);
    assert.match(text, /builder_inline_layer/);
});

const PRIOR = [{ id: 'a', prompt: 'Which inbox?', options: ['Finance', 'Sales'] }, { id: 'b', prompt: 'How many retries?', options: ['3', '0'] }];

test('questionStatusNote: answered on the card, in plan mode and in an approved build', () => {
    const answered = 'Q: Which inbox?\nA: Sales\n\nQ: How many retries?\nA: 3';
    const plan = questionStatusNote({ prior: PRIOR, answeredText: answered, mode: 'plan' });
    assert.match(plan, /answered the 2 questions you asked/);
    assert.match(plan, /Do not ask them again/);
    assert.match(plan, /Call builder_write_plan now; put anything still open under assumptions/);
    const build = questionStatusNote({ prior: PRIOR, answeredText: answered, mode: 'build', approvedPlan: { id: 'p1' } });
    assert.match(build, /Continue the approved plan/);
    assert.doesNotMatch(build, /builder_write_plan/);
});

test('questionStatusNote: a typed message lists the questions with the suggestion, and no questions means no note', () => {
    const typed = questionStatusNote({ prior: PRIOR, answeredText: 'just use the finance inbox', mode: 'plan' });
    assert.match(typed, /Your last turn asked: 1\) Which inbox\? \(suggested: Finance\) 2\) How many retries\? \(suggested: 3\)/);
    assert.match(typed, /wrote a message instead of using the card/);
    assert.match(typed, /list it as an assumption/);
    assert.match(typed, /Do not ask these again/);
    assert.equal(questionStatusNote({ prior: null, answeredText: 'hi', mode: 'plan' }), '');
    assert.equal(questionStatusNote({ prior: [], answeredText: 'hi', mode: 'plan' }), '');
    // A Q/A text for questions the model never asked is a typed message, not an answer.
    assert.match(questionStatusNote({ prior: PRIOR, answeredText: 'Q: Something else?\nA: x', mode: 'plan' }), /instead of using the card/);
});

test('reviewStatusNote: a plan that waits is built by the button only', () => {
    const note = reviewStatusNote({ plan: { id: 'p1', version: 3, status: 'review' }, planCurrent: true });
    assert.match(note, /PLAN v3 WAITS FOR APPROVAL/);
    assert.match(note, /Only the user's Build this plan button builds it/);
    assert.match(note, /answer in one sentence asking them to press Build this plan/);
    assert.equal(reviewStatusNote({ plan: { id: 'p1', version: 3, status: 'review' }, planCurrent: false }), '');
    assert.equal(reviewStatusNote({ plan: { id: 'p1', version: 3, status: 'built' }, planCurrent: true }), '');
});
