// @typecheck
/**
 * What a plan may do, which plan was approved, and when a changed plan needs approval again
 * (./planPermissions.mts).
 *
 * Run: cd server && node --test core/cowork/plan/planPermissions.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { permissionsOf, widens, planFingerprint, plainPlan, LAYOUT_NODE_KEYS } = require('./planPermissions.mts');
const { fakeLookups, planOf, supplierRadar, literal, ref } = require('./plan.testkit');

const lookups = fakeLookups();
const clone = (v) => JSON.parse(JSON.stringify(v));

test('the running example may read Outlook, write Outlook drafts and its table, use AI, and reach only its owner', () => {
    assert.deepStrictEqual(permissionsOf(supplierRadar(), lookups), {
        v: 1,
        grants: [
            { app: 'datatables', effect: 'writes', tools: ['datatable.save_row'] },
            { app: 'outlook', effect: 'reads', tools: ['outlook_search'] },
            { app: 'outlook', effect: 'writes', tools: ['outlook_create_draft'] },
        ],
        sends: 'owner',
        ai: true,
        outsideText: true,
    });
});

test('grants are per app and effect, with every tool behind them once, in a fixed order', () => {
    const plan = planOf([
        { id: 'a', type: 'integration_action', tool: 'outlook_read' },
        { id: 'b', type: 'integration_action', tool: 'outlook_search' },
        { id: 'c', type: 'integration_action', tool: 'outlook_read' },
        { id: 'd', type: 'integration_action', tool: 'drive_search' },
        { id: 'e', type: 'integration_action', tool: 'outlook_compose' },
    ]);
    assert.deepStrictEqual(permissionsOf(plan, lookups).grants, [
        { app: 'google-drive', effect: 'reads', tools: ['drive_search'] },
        { app: 'outlook', effect: 'reads', tools: ['outlook_read', 'outlook_search'] },
        { app: 'outlook', effect: 'sends', tools: ['outlook_compose'] },
    ]);
});

test('the tools an AI step is offered are part of what the plan may do', () => {
    const plan = planOf([{ id: 'a', type: 'ai_step', prompt: 'x', tools: ['drive_search', 'drive_upload'] }]);
    assert.deepStrictEqual(permissionsOf(plan, lookups).grants, [
        { app: 'google-drive', effect: 'reads', tools: ['drive_search'] },
        { app: 'google-drive', effect: 'writes', tools: ['drive_upload'] },
    ]);
});

test('a knowledge base an AI step is grounded on is something the plan reads, and a new one widens', () => {
    const grounded = (ids) => permissionsOf(planOf([{ id: 'a', type: 'ai_step', prompt: 'x', knowledgeBaseIds: ids }]), lookups);
    assert.deepStrictEqual(grounded(['kb-1', 'kb-2', '', 7]).grants, [{ app: 'knowledge-bases', effect: 'reads', tools: ['knowledge_base:kb-1', 'knowledge_base:kb-2'] }]);
    assert.deepStrictEqual(grounded([]).grants, []);
    assert.deepStrictEqual(widens(grounded(['kb-1', 'kb-2']), grounded(['kb-1'])).length, 1);
    assert.deepStrictEqual(widens(grounded(['kb-1']), grounded(['kb-1', 'kb-2'])), []);
});

test('a table step reads or writes the organisation\'s tables by its operation; a document step writes a document', () => {
    const plan = planOf([
        { id: 'find', type: 'datatable', datatableId: 't1', op: 'find_rows' },
        { id: 'add', type: 'datatable', datatableId: 't1', op: 'add_row' },
        { id: 'doc', type: 'generate_document', content: 'x' },
    ]);
    assert.deepStrictEqual(permissionsOf(plan, lookups).grants, [
        { app: 'datatables', effect: 'reads', tools: ['datatable.find_rows'] },
        { app: 'datatables', effect: 'writes', tools: ['datatable.add_row'] },
        { app: 'documents', effect: 'writes', tools: ['generate_document'] },
    ]);
});

test('a built-in tool no app owns, and a tool nobody classified, are listed under Bee Flow as a write', () => {
    const plan = planOf([{ id: 'a', type: 'integration_action', tool: 'set_reminder' }, { id: 'b', type: 'integration_action', tool: 'never_heard_of' }]);
    assert.deepStrictEqual(permissionsOf(plan, lookups).grants, [{ app: 'bee-flow', effect: 'writes', tools: ['never_heard_of', 'set_reminder'] }]);
});

test('who it reaches: nobody, only its owner (a result, a question), or other people (a send in an app)', () => {
    const reach = (steps) => permissionsOf(planOf(steps), lookups).sends;
    assert.strictEqual(reach([{ id: 'a', type: 'set', values: {} }]), 'none');
    assert.strictEqual(reach([{ id: 'a', type: 'notification', title: 't', body: 'b' }]), 'owner');
    assert.strictEqual(reach([{ id: 'a', type: 'approval', prompt: 'OK?' }]), 'owner');
    assert.strictEqual(reach([{ id: 'a', type: 'notification', title: 't', body: 'b' }, { id: 'b', type: 'integration_action', tool: 'outlook_compose' }]), 'others');
    assert.strictEqual(reach([{ id: 'a', type: 'ai_step', prompt: 'x', tools: ['outlook_reply_in_thread'] }]), 'others', 'through an AI step\'s tool too');
});

test('it says whether a model is called and whether outside text is read', () => {
    const quiet = permissionsOf(planOf([{ id: 'a', type: 'integration_action', tool: 'drive_search' }]), lookups);
    assert.deepStrictEqual([quiet.ai, quiet.outsideText], [false, false]);
    const mailTrigger = { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } };
    assert.strictEqual(permissionsOf(planOf([{ id: 'a', type: 'set', values: {} }], mailTrigger), lookups).outsideText, true, 'a mail trigger alone is outside text');
});

// ── widens ──────────────────────────────────────────────────────────────

const approved = permissionsOf(supplierRadar(), lookups);

test('the same plan does not widen, and neither does one that does less', () => {
    assert.deepStrictEqual(widens(approved, approved), []);
    const less = supplierRadar();
    less.steps = less.steps.filter((s) => !['reply', 'draft', 'digest'].includes(s.id));
    assert.deepStrictEqual(widens(permissionsOf(less, lookups), approved), []);
});

test('a new app, a stronger effect on a known app and a new tool each widen, and are named', () => {
    const plan = supplierRadar();
    plan.steps.push({ id: 'x', type: 'integration_action', tool: 'drive_search' });
    plan.steps.push({ id: 'y', type: 'integration_action', tool: 'outlook_read' });
    assert.deepStrictEqual(widens(permissionsOf(plan, lookups), approved), ['google-drive: reads (drive_search)', 'outlook: reads (outlook_read)']);
});

test('a first send to other people widens', () => {
    const plan = supplierRadar();
    plan.steps.push({ id: 'x', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('a@example.com') } });
    assert.deepStrictEqual(widens(permissionsOf(plan, lookups), approved), ['outlook: sends (outlook_compose)', 'It can now send to other people.']);
});

test('a first model call and a first read of outside text widen', () => {
    const before = permissionsOf(planOf([{ id: 'a', type: 'integration_action', tool: 'drive_search' }]), lookups);
    const after = permissionsOf(planOf([
        { id: 'a', type: 'integration_action', tool: 'drive_search' },
        { id: 'm', type: 'integration_action', tool: 'outlook_read' },
        { id: 'b', type: 'ai_step', prompt: '{{steps.m.output.body}}' },
    ]), lookups);
    assert.deepStrictEqual(widens(after, before), ['outlook: reads (outlook_read)', 'It now uses AI.', 'It now reads text written outside the workspace.']);
});

test('a first result to the owner widens from "reaches nobody"', () => {
    const before = permissionsOf(planOf([{ id: 'a', type: 'set', values: {} }]), lookups);
    const after = permissionsOf(planOf([{ id: 'a', type: 'set', values: {} }, { id: 'n', type: 'notification', title: 't', body: 'b' }]), lookups);
    assert.deepStrictEqual(widens(after, before), ['It can now send to its owner.']);
});

test('a plan that was never approved always widens', () => {
    assert.deepStrictEqual(widens(approved, null), ['This plan has not been approved yet.']);
});

// ── fingerprint ─────────────────────────────────────────────────────────

test('the fingerprint is the same for the same plan, however its keys are ordered', () => {
    const a = supplierRadar();
    const b = clone(a);
    b.steps = b.steps.map((s) => Object.fromEntries(Object.entries(s).reverse()));
    assert.match(planFingerprint(a), /^[0-9a-f]{64}$/);
    assert.strictEqual(planFingerprint(a), planFingerprint({ edges: b.edges, steps: b.steps, trigger: b.trigger }));
});

test('moving a step on the canvas, recolouring it or adding a note does not change it', () => {
    const base = supplierRadar();
    const moved = clone(base);
    moved.steps[0].position = { x: 400, y: 80 };
    moved.steps[1].color = '#3f6fc4';
    moved.steps[2].icon = 'filter';
    moved.edges[0].color = '#000000';
    moved.piiLineColors = { a: 'b' };
    moved.steps.push({ id: 'n', type: 'note', text: 'check this' });
    assert.strictEqual(planFingerprint(moved), planFingerprint(base));
});

test('any change to what the plan does changes it: a tool, a recipient, a prompt, an edge, the schedule', () => {
    const base = planFingerprint(supplierRadar());
    const changes = [
        (p) => { p.steps[5].tool = 'outlook_compose'; },
        (p) => { p.steps[5].inputs.to = literal('someone-else@example.com'); },
        (p) => { p.steps[4].prompt += ' Be brief.'; },
        (p) => { p.edges.pop(); },
        (p) => { p.trigger.cron = '0 9 * * 1'; },
        (p) => { p.steps.splice(2, 1); },
        (p) => { p.steps[0].inputs.extra = ref('trigger.output.time'); },
    ];
    for (const [i, change] of changes.entries()) {
        const plan = supplierRadar();
        change(plan);
        assert.notStrictEqual(planFingerprint(plan), base, `change ${i}`);
    }
});

test('a change inside a loop changes it, and layout inside a loop does not', () => {
    const loop = (body) => planOf([{ id: 'each', type: 'loop', items: literal([1]), body }]);
    const base = planFingerprint(loop([{ id: 'one', type: 'ai_step', prompt: 'x' }]));
    assert.strictEqual(planFingerprint(loop([{ id: 'one', type: 'ai_step', prompt: 'x', position: { x: 1, y: 2 } }])), base);
    assert.notStrictEqual(planFingerprint(loop([{ id: 'one', type: 'ai_step', prompt: 'y' }])), base);
});

test('the layout keys are the automation diff\'s own: what it calls a layout-only change never changes a fingerprint', () => {
    const fieldDiff = require('../../../automation/fieldDiff');
    assert.deepStrictEqual([...LAYOUT_NODE_KEYS].sort(), [...fieldDiff.LAYOUT_NODE_KEYS].sort());
    const base = supplierRadar();
    const moved = clone(base);
    for (const [i, step] of moved.steps.entries()) for (const key of fieldDiff.LAYOUT_NODE_KEYS) step[key] = `${key}-${i}`;
    assert.strictEqual(fieldDiff.isLayoutOnlyChange(base, moved), true);
    assert.strictEqual(planFingerprint(moved), planFingerprint(base));
});

test('the plain plan keeps every field that is not layout, also ones this file has never heard of', () => {
    const plan = planOf([{ id: 'a', type: 'set', values: {}, somethingNew: { deep: true }, position: { x: 1 } }]);
    plan.settings = { retries: 2 };
    const plain = plainPlan(plan);
    assert.deepStrictEqual(plain.steps, [{ id: 'a', type: 'set', values: {}, somethingNew: { deep: true } }]);
    assert.deepStrictEqual(plain.settings, { retries: 2 });
});

test('nothing at all has a fingerprint too, and it is not the fingerprint of a plan', () => {
    assert.strictEqual(planFingerprint(null), planFingerprint(undefined));
    assert.notStrictEqual(planFingerprint(null), planFingerprint(supplierRadar()));
});
