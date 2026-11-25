/**
 * What the last test of a plan produced (./coworkPlanTryResult.mts): the message the plan would have delivered, read
 * only from a try-out that passed and tried exactly the plan of the moment. The automation lookup, the run rows and the
 * try-out record are handed in, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkPlanTryResult.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { triedResultOf, resultIn } = require('./coworkPlanTryResult.mts');
const { planFingerprint } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups, planOf, supplierRadar, literal } = require('../core/cowork/plan/plan.testkit');

const ITEM = { id: 's1', userId: 'u1', planAutomationId: 'auto-1' };
const DIGEST = { stepId: 'digest', attempts: 1, status: 'success', output: { _dryRun: true, wouldNotify: { title: 'Supplier radar', body: '3 orders are overdue.', channels: ['notification'] } } };

function world({ definition = supplierRadar(), record = {}, run = {}, rows = [DIGEST], owner = 'u1' } = {}) {
    const read = [];
    const deps = {
        getAutomation: async () => ({ id: 'auto-1', userId: owner, organizationId: 'org-1', kind: 'automation', definition }),
        isManaged: async () => false,
        getRun: async (id) => { read.push(['getRun', id]); return { id, automationId: 'auto-1', mode: 'dry_run', status: 'success', ...run }; },
        getRunSteps: async (id) => { read.push(['getRunSteps', id]); return rows; },
        getPlanTry: async () => (record === null ? null : { automationId: 'auto-1', fingerprint: planFingerprint(definition), tryId: 'try-1', status: 'passed', required: true, summary: null, problems: [], rounds: 1, at: '', ...record }),
        lookups: fakeLookups(),
    };
    return { deps, read };
}

test('the result is what the plan would have delivered to its owner: the title and the text of its last result step', async () => {
    const { deps, read } = world();
    assert.deepStrictEqual(await triedResultOf({ item: ITEM }, deps), { stepId: 'digest', title: 'Supplier radar', text: '3 orders are overdue.' });
    assert.deepStrictEqual(read, [['getRun', 'try-1'], ['getRunSteps', 'try-1']]);
});

test('nothing is read or said for a try-out that did not pass, that tried other steps, or that is of another automation', async () => {
    const cases = /** @type {Array<[string, Record<string, unknown> | null]>} */ ([
        ['no try-out at all', null],
        ['still running', { status: 'running' }],
        ['failed', { status: 'failed' }],
        ['never started', { tryId: null }],
        ['of an earlier plan', { fingerprint: 'b'.repeat(64) }],
        ['of another automation', { automationId: 'auto-2' }],
    ]);
    for (const [name, record] of cases) {
        const { deps, read } = world({ record });
        assert.strictEqual(await triedResultOf({ item: ITEM }, deps), null, name);
        assert.deepStrictEqual(read, [], `${name}: no run is read`);
    }
});

test('a run that is no try-out of this plan says nothing, and neither does a plan that is no longer its owner\'s', async () => {
    for (const run of [{ mode: 'live' }, { automationId: 'auto-2' }]) {
        const { deps } = world({ run });
        assert.strictEqual(await triedResultOf({ item: ITEM }, deps), null, JSON.stringify(run));
    }
    const other = world({ owner: 'someone-else' });
    assert.strictEqual(await triedResultOf({ item: ITEM }, other.deps), null);
    assert.deepStrictEqual(other.read, []);
});

test('the last attempt of the result step counts, a long text is cut, and a title that only repeats the text is left out', () => {
    const lookups = fakeLookups();
    const rows = [
        { stepId: 'digest', attempts: 1, status: 'error', output: { wouldNotify: { title: 'Old', body: 'First try' } } },
        { stepId: 'digest', attempts: 2, status: 'success', output: { wouldNotify: { title: 'Same', body: 'Same' } } },
    ];
    assert.deepStrictEqual(resultIn(supplierRadar(), rows, lookups), { stepId: 'digest', title: null, text: 'Same' });
    const long = resultIn(supplierRadar(), [{ stepId: 'digest', attempts: 1, output: { wouldNotify: { title: 'T', body: 'x'.repeat(5000) } } }], lookups);
    assert.strictEqual(long?.text.length, 4001);
    assert.ok(long?.text.endsWith('…'));
});

test('a long AI answer is unwrapped before the preview is cut', () => {
    const answer = `# Digest\n\n- ${'x'.repeat(5000)}`;
    const rows = [{ stepId: 'digest', attempts: 1, output: { wouldNotify: { body: JSON.stringify({ answer }) } } }];
    const result = resultIn(supplierRadar(), rows, fakeLookups());
    assert.strictEqual(result?.text, `${answer.slice(0, 4000)}…`);
});

test('a plan without a result for its owner shows what its last sending step would have sent; a plan that sends nothing shows nothing', () => {
    const lookups = fakeLookups();
    const mails = planOf([
        { id: 'find', type: 'integration_action', tool: 'outlook_search', inputs: { query: literal('is:unread') } },
        { id: 'first', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('a@x.example'), body: literal('First message') } },
        { id: 'second', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('b@x.example'), body: literal('Second message') } },
    ]);
    const rows = [
        { stepId: 'find', attempts: 1, output: { messages: ['a long text that was only read, never sent to anyone at all'] } },
        { stepId: 'first', attempts: 1, input: { to: 'a@x.example', body: 'The first message, as written' }, output: { _dryRun: true } },
        { stepId: 'second', attempts: 1, input: { to: 'b@x.example', body: 'The second message, as written' }, output: { _dryRun: true } },
    ];
    assert.deepStrictEqual(resultIn(mails, rows, lookups), { stepId: 'second', title: null, text: 'The second message, as written' });
    assert.strictEqual(resultIn(planOf([mails.steps[0]]), rows, lookups), null);
    assert.strictEqual(resultIn(supplierRadar(), [], lookups), null, 'a result step the try-out never reached');
});
