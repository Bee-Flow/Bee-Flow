/**
 * The wiring check (./planWiring.mts) and its fixes (./planWiringFix.mts) on the owner's Fireflies plan as the planner
 * made it on dev: the trigger fans out to the AI step, "Nu" and "Een week geleden"; "Een week geleden" reads a datetime
 * step that is not in the plan (`dt_ac3ed7`), inside {{ }}; the AI step reads nothing and runs first.
 *
 * Run: cd server && node --test core/cowork/plan/planWiring.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { wiringFindings, WIRING_BLOCKING } = require('./planWiring.mts');
const { fixWiring, applyWiringFix, sameWiringReach, wiringChangesOf } = require('./planWiringFix.mts');
const { knowsPath } = require('../../../usecases/coworkPlanRefs.mts');
const { permissionsOf } = require('./planPermissions.mts');
const { fakeLookups } = require('./plan.testkit');

const lookups = fakeLookups({ fireflies_list_transcripts: ['fireflies', 'reads'], fireflies_get_summary: ['fireflies', 'reads'] });
const opts = { knowsPath };
const ref = (path) => ({ kind: 'ref', path });
const codes = (findings) => findings.map((f) => [f.code, f.stepId]);

/** The owner's plan, version 1. */
function ownersPlan() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'schedule' },
        steps: [
            { id: 'ai_1', type: 'ai_step', label: 'AI step', prompt: 'Write a short overview of last week\'s meetings.' },
            { id: 'dt_now', type: 'datetime', label: 'Nu', op: 'now' },
            { id: 'dt_week', type: 'datetime', label: 'Een week geleden', op: 'addDays', amount: -7, input: '{{steps.dt_ac3ed7.output.iso}}' },
            { id: 'ff_list', type: 'integration_action', label: 'Fireflies list transcripts', tool: 'fireflies_list_transcripts', inputs: { fromDate: ref('steps.dt_week.output.iso') } },
            { id: 'ff_sum', type: 'integration_action', label: 'Fireflies get summary', tool: 'fireflies_get_summary', inputs: { transcriptId: ref('loop.t.id') }, forEach: { overRef: 'steps.ff_list.output.results', itemVar: 't' } },
            { id: 'tell', type: 'notification', label: 'Stuur mij het overzicht', title: 'Meetings', body: '{{steps.ai_1.output}}', channels: ['notification'] },
        ],
        edges: [
            { from: 'trg', to: 'ai_1' }, { from: 'trg', to: 'dt_now' }, { from: 'trg', to: 'dt_week' },
            { from: 'dt_week', to: 'ff_list' }, { from: 'ff_list', to: 'ff_sum' }, { from: 'ai_1', to: 'tell' }, { from: 'ff_sum', to: 'tell' },
        ],
    };
}

/** The same plan wired right: now → a week ago → list → summaries → AI → tell. */
function wiredRight() {
    const def = ownersPlan();
    def.steps[0].prompt = 'Write a short overview of last week\'s meetings: {{steps.ff_sum.output.results}}';
    def.steps[2].input = 'steps.dt_now.output.iso';
    def.edges = [
        { from: 'trg', to: 'dt_now' }, { from: 'dt_now', to: 'dt_week' }, { from: 'dt_week', to: 'ff_list' },
        { from: 'ff_list', to: 'ff_sum' }, { from: 'ff_sum', to: 'ai_1' }, { from: 'ai_1', to: 'tell' },
    ];
    return def;
}

test('the owner\'s plan: an unknown step, an AI step without input, and a read nobody uses', () => {
    const found = wiringFindings(ownersPlan(), lookups, { ...opts, advice: true });
    assert.deepStrictEqual(codes(found), [
        ['wiring.ref_unknown_step', 'dt_week'],
        ['wiring.ai_without_input', 'ai_1'],
        ['wiring.read_unused', 'ff_sum'],
    ]);
    assert.strictEqual(found[0].message, '\'Een week geleden\' reads from a step that is not in this plan. It should read from \'Nu\'.');
    assert.match(found[1].message, /^'AI step' starts right away and reads none of the steps that fetch the data it should work on\. Let it wait for 'Fireflies get summary' and read its output\.$/);
    assert.strictEqual(found[2].message, '\'Fireflies get summary\' reads data that no later step uses.');
    assert.ok(found.filter((f) => WIRING_BLOCKING.has(f.code)).length === 2, 'read_unused is advice');
});

test('ref_unknown_step: fixed by the single datetime step with `iso`, the braces taken off, and the edge from it', () => {
    const [unknown] = wiringFindings(ownersPlan(), lookups, opts);
    assert.deepStrictEqual(unknown.fix, { kind: 'reread', stepId: 'dt_week', from: 'dt_ac3ed7', to: 'dt_now' });
    const fixed = fixWiring(ownersPlan(), lookups, opts);
    const week = fixed.definition.steps.find((s) => s.id === 'dt_week');
    assert.strictEqual(week.input, 'steps.dt_now.output.iso', 'the id of Nu, as a bare path');
    assert.ok(fixed.definition.edges.some((e) => e.from === 'dt_now' && e.to === 'dt_week'), 'it waits for Nu');
    assert.ok(!fixed.definition.edges.some((e) => e.from === 'trg' && e.to === 'dt_week'), 'and no longer starts beside it');
});

test('ref_unknown_step with two steps that have the path: no fix, never a guess', () => {
    const def = ownersPlan();
    def.steps.splice(2, 0, { id: 'dt_other', type: 'datetime', label: 'Ook nu', op: 'now' });
    def.edges.push({ from: 'trg', to: 'dt_other' });
    const [unknown] = wiringFindings(def, lookups, opts);
    assert.deepStrictEqual([unknown.code, unknown.fix], ['wiring.ref_unknown_step', null]);
});

test('ai_without_input: fixed by moving the AI step after the reads, with their output in its prompt', () => {
    const def = ownersPlan();
    def.steps[2].input = 'steps.dt_now.output.iso';
    def.edges.push({ from: 'dt_now', to: 'dt_week' });
    const found = wiringFindings(def, lookups, opts);
    assert.deepStrictEqual(codes(found), [['wiring.ai_without_input', 'ai_1']]);
    const after = applyWiringFix(def, found[0].fix);
    const ai = after.steps.find((s) => s.id === 'ai_1');
    assert.ok(ai.prompt.endsWith('{{steps.ff_sum.output}}'), ai.prompt);
    assert.ok(after.edges.some((e) => e.from === 'ff_sum' && e.to === 'ai_1'));
    assert.ok(!after.edges.some((e) => e.from === 'trg' && e.to === 'ai_1'));
    assert.deepStrictEqual(wiringFindings(after, lookups, { ...opts, advice: true }), [], 'wired right now, and the summaries are used');
    assert.ok(def.edges.some((e) => e.from === 'trg' && e.to === 'ai_1'), 'the plan handed in is not changed');
});

test('ref_not_upstream: fixed with an edge; a cycle is refused', () => {
    const def = wiredRight();
    // The AI step reads the summaries but is wired from the trigger again.
    def.edges = def.edges.filter((e) => e.to !== 'ai_1').concat({ from: 'trg', to: 'ai_1' });
    const [late] = wiringFindings(def, lookups, opts);
    assert.deepStrictEqual([late.code, late.stepId, late.sourceId], ['wiring.ref_not_upstream', 'ai_1', 'ff_sum']);
    assert.deepStrictEqual(late.fix, { kind: 'wait', stepId: 'ai_1', after: ['ff_sum'], addRefs: [] });
    assert.match(late.message, /^'AI step' reads from 'Fireflies get summary', but does not wait for it/);

    // "Fireflies list transcripts" reads the AI step's output, which comes after it: an edge would close a cycle.
    const loop = wiredRight();
    loop.steps[3].inputs.title = ref('steps.ai_1.output.text');
    const [cycle] = wiringFindings(loop, lookups, opts);
    assert.deepStrictEqual([cycle.code, cycle.stepId, cycle.fix], ['wiring.ref_not_upstream', 'ff_list', null]);
    assert.match(cycle.message, /'AI step' cannot come before it\.$/);
});

test('a read whose output is unused gives read_unused, as advice', () => {
    const def = wiredRight();
    def.steps.splice(5, 0, { id: 'extra', type: 'integration_action', label: 'Fireflies list again', tool: 'fireflies_list_transcripts', inputs: {} });
    def.edges.push({ from: 'ff_sum', to: 'extra' });
    assert.deepStrictEqual(wiringFindings(def, lookups, opts), [], 'no finding that stops an approval');
    assert.deepStrictEqual(codes(wiringFindings(def, lookups, { ...opts, advice: true })), [['wiring.read_unused', 'extra']]);
});

test('a correct plan gives no findings', () => {
    assert.deepStrictEqual(wiringFindings(wiredRight(), lookups, { ...opts, advice: true }), []);
});

test('the whole fix of the owner\'s plan reaches exactly what it reached, and says what changed', () => {
    const before = ownersPlan();
    const fixed = fixWiring(before, lookups, opts);
    assert.deepStrictEqual(fixed.remaining, []);
    assert.deepStrictEqual(wiringFindings(fixed.definition, lookups, { ...opts, advice: true }), []);
    assert.ok(sameWiringReach(before, fixed.definition, lookups), 'same steps, tools, inputs and permissions');
    assert.deepStrictEqual(permissionsOf(fixed.definition, lookups), permissionsOf(before, lookups));
    assert.deepStrictEqual(fixed.changes, [{ kind: 'reads', stepId: 'dt_week', otherId: 'dt_now' }, { kind: 'waits', stepId: 'ai_1', otherId: 'ff_sum' }]);
    assert.deepStrictEqual(wiringChangesOf(before, fixed.definition).map((c) => [c.kind, c.stepId, c.otherId]), [['reads', 'ai_1', 'ff_sum'], ['reads', 'dt_week', 'dt_now']]);
});

test('a change beyond references and edges does not reach the same', () => {
    const before = ownersPlan();
    const fixed = fixWiring(before, lookups, opts).definition;
    const otherTool = structuredClone(fixed);
    otherTool.steps[4].tool = 'fireflies_get_transcript';
    assert.ok(!sameWiringReach(before, otherTool, lookups), 'a tool changed');
    const otherText = structuredClone(fixed);
    otherText.steps[0].prompt = 'Send the meetings to everyone.';
    assert.ok(!sameWiringReach(before, otherText, lookups), 'the prompt\'s own words changed');
    const branchEdge = structuredClone(fixed);
    branchEdge.edges.push({ from: 'ff_list', to: 'tell', label: 'on_error' });
    assert.ok(!sameWiringReach(before, branchEdge, lookups), 'an edge with a label');
});

test('a reference inside text that only says "steps." is no reference', () => {
    const def = wiredRight();
    def.steps[0].prompt += ' Follow the steps.Then write.';
    assert.deepStrictEqual(wiringFindings(def, lookups, opts), []);
});
