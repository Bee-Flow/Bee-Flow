/**
 * The rules of a goal's check (./goalCheck.mts): a plan of fixed steps that only read and end on met and total. A
 * check with a change, a send or an AI step is refused, whatever else it holds.
 *
 * Run: cd server && node --test core/cowork/goals/goalCheck.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { goalCheckFindings, countOf } = require('./goalCheck.mts');
const { fakeLookups } = require('../plan/plan.testkit');

const lookups = fakeLookups();
const literal = (value) => ({ kind: 'literal', value });
const expr = (value) => ({ kind: 'expr', value });
const MANUAL = { id: 'trg', type: 'trigger', kind: 'manual' };

/** A definition from a list of steps, wired in order. */
function checkOf(steps, trigger = MANUAL) {
    const ids = [trigger.id, ...steps.map((s) => s.id)];
    return { trigger, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })) };
}

const READ = { id: 'mail', type: 'integration_action', label: 'Read the supplier mail of this week', tool: 'outlook_search', inputs: { query: literal('from:suppliers newer_than:7d') } };
const KEEP = { id: 'answered', type: 'filter', label: 'Keep what was answered in time', items: { kind: 'ref', value: 'steps.mail.output.messages' }, where: 'workdaysBetween(item.receivedAt, item.answeredAt) <= 2' };
const COUNT = { id: 'count', type: 'set', label: 'Count', fields: { met: expr('len(steps.answered.output.items)'), total: expr('len(steps.mail.output.messages)'), period: literal('this week') } };

const codes = (def) => goalCheckFindings(def, lookups).map((f) => f.code);

test('a check that reads, keeps and counts may measure a goal', () => {
    assert.deepStrictEqual(goalCheckFindings(checkOf([READ, KEEP, COUNT]), lookups), []);
    assert.deepStrictEqual(codes(checkOf([{ id: 'calc', type: 'code', code: 'return 1' }, COUNT])), [], 'a script is a calculation: it reads');
    assert.deepStrictEqual(codes(checkOf([{ id: 'rows', type: 'datatable', op: 'count_rows', datatableId: 'dt1', where: [] }, COUNT])), [], 'counting rows of a table reads');
});

test('a check with a change, a send or an AI step is refused', () => {
    const cases = [
        [{ id: 'draft', type: 'integration_action', label: 'Draft a reply', tool: 'outlook_create_draft', inputs: {} }, 'goal.not_read_only'],
        [{ id: 'send', type: 'integration_action', label: 'Send it', tool: 'outlook_compose', inputs: {} }, 'goal.not_read_only'],
        [{ id: 'row', type: 'datatable', op: 'add_row', datatableId: 'dt1', label: 'Log it' }, 'goal.not_read_only'],
        [{ id: 'odd', type: 'datatable', op: 'insert', datatableId: 'dt1', label: 'An operation nobody knows' }, 'goal.not_read_only'],
        [{ id: 'doc', type: 'generate_document', label: 'Write a report' }, 'goal.not_read_only'],
        [{ id: 'unknown', type: 'integration_action', label: 'Something new', tool: 'never_classified', inputs: {} }, 'goal.not_read_only'],
        [{ id: 'judge', type: 'ai_step', label: 'Judge the answers', prompt: 'Were these answered well?' }, 'goal.not_fixed'],
        [{ id: 'pick', type: 'data_extraction', label: 'Pick the dates', fields: [{ name: 'date' }] }, 'goal.not_fixed'],
        [{ id: 'ask', type: 'approval', label: 'Ask me', prompt: 'Count this?' }, 'goal.not_fixed'],
        [{ id: 'tell', type: 'notification', label: 'Tell me', title: 'Goal', body: 'done' }, 'goal.not_fixed'],
    ];
    for (const [step, code] of cases) {
        const findings = goalCheckFindings(checkOf([READ, step, COUNT]), lookups);
        const mine = findings.filter((f) => f.stepId === step.id);
        assert.ok(mine.some((f) => f.code === code), `${step.id}: ${JSON.stringify(findings)}`);
        assert.ok(mine.every((f) => typeof f.message === 'string' && f.message.length > 10));
    }
});

test('a step inside a loop is held to the same rules', () => {
    const loop = { id: 'each', type: 'loop', label: 'For each mail', items: { kind: 'ref', value: 'steps.mail.output.messages' }, body: [{ id: 'inner', type: 'integration_action', tool: 'outlook_compose', inputs: {} }] };
    assert.ok(codes(checkOf([READ, loop, COUNT])).includes('goal.not_read_only'));
});

test('a check ends on one set step that writes met and total, once', () => {
    assert.deepStrictEqual(codes(checkOf([READ, KEEP])), ['goal.no_count'], 'it ends on a filter');
    assert.deepStrictEqual(codes(checkOf([READ, { ...COUNT, fields: { met: literal(1) } }])), ['goal.no_count']);
    assert.match(goalCheckFindings(checkOf([READ, { ...COUNT, fields: { met: literal(1) } }]), lookups)[0].message, /no total/);
    assert.deepStrictEqual(codes(checkOf([READ, { ...COUNT, arrayRef: 'steps.mail.output.messages' }])), ['goal.no_count'], 'per row is no count');
    const twoEnds = { trigger: MANUAL, steps: [READ, COUNT], edges: [{ from: 'trg', to: 'mail' }, { from: 'trg', to: 'count' }] };
    assert.deepStrictEqual(codes(twoEnds), ['goal.no_count'], 'two steps it could end on');
});

test('a check starts when its cowork asks, and it is a plan Cowork runs', () => {
    assert.deepStrictEqual(codes(checkOf([READ, COUNT], { id: 'trg', type: 'trigger', kind: 'schedule', cron: '0 8 * * *' })), ['goal.trigger']);
    assert.ok(codes(checkOf([{ id: 'web', type: 'http_request', url: 'https://example.com' }, COUNT])).includes('step.not_allowed'));
    assert.deepStrictEqual(codes(null), ['plan.shape']);
    assert.deepStrictEqual(codes({ trigger: MANUAL, steps: [], edges: [] }), ['plan.empty', 'goal.no_count']);
});

test('the count is two whole numbers, met never above total; a period is optional', () => {
    assert.deepStrictEqual(countOf({ met: 46, total: 49, period: ' this week ' }), { ok: true, met: 46, total: 49, period: 'this week' });
    assert.deepStrictEqual(countOf({ met: '3', total: '4' }), { ok: true, met: 3, total: 4, period: null });
    for (const bad of [null, [], 'text', { met: 1 }, { met: 1.5, total: 2 }, { met: 'many', total: 3 }, { met: -1, total: 3 }, { met: 5, total: 3 }]) {
        const count = countOf(bad);
        assert.strictEqual(count.ok, false, JSON.stringify(bad));
        assert.ok(count.reason.length > 10);
    }
});
