/**
 * Which run the "## Last run" block reads (lastRunContext.mts), and the mask
 * on its error texts: the owner only, the first run they may read, only when
 * it is newer than the session, the texts masked or left out.
 *
 * Run: cd server && node --test usecases/ai/automationBuilder/lastRunContext.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lastRunBlock } = require('./lastRunContext.mts');
const { maskedRunValues } = require('../../../routes/ai/automationBuilder/inspectionTools');
const { tokenizeText } = require('../../../core/privacy/piiDetection/tokenizer');
const { canReadRunData } = require('../../../core/automationModel/callerRunVisibility');

const SINCE = '2026-11-04T11:00:00.000Z';
const RUN = { id: 'r2', automationId: 'a1', mode: 'live', isTest: true, status: 'error', startedAt: '2026-11-04T11:55:00.000Z', finishedAt: '2026-11-04T11:55:09.000Z' };
const STEPS = {
    r2: [
        { stepId: 'form', stepType: 'form_trigger', status: 'success', output: { email: 'person@example.test' } },
        { stepId: 'ai', stepType: 'ai_step', status: 'error', error: 'prioriteit: the list of allowed values is empty; asked by person@example.test', errorInfo: { code: 'ai_checks_failed' } },
    ],
};

function deps({ owner = 'u1', runs = [RUN], steps = STEPS, detectPii = async () => ({ hasPii: true, entities: [{ text: 'person@example.test', label: 'Email', score: 1 }] }), store = {} } = {}) {
    const calls = { runs: 0, steps: [], masked: [], warned: [] };
    return {
        calls,
        deps: {
            store: {
                async getAutomation(id) { return id === 'a1' ? { id, userId: owner } : null; },
                async listRunsForAutomation(_id, filters) { calls.runs += 1; calls.limit = filters.limit; return { runs }; },
                async getRunSteps(id) { calls.steps.push(id); return steps[id] || []; },
                ...store,
            },
            mask: async (values) => { calls.masked.push(values); return maskedRunValues(values, { detectPii, tokenizeText }); },
            canRead: canReadRunData,
            warn: (m) => calls.warned.push(m),
        },
    };
}

test('a failed run newer than the session: its steps, the code and the masked message', async () => {
    const { deps: d, calls } = deps();
    const text = await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, d);
    assert.match(text, /^## Last run/);
    assert.match(text, /- `ai` \(ai_step\) failed with code `ai_checks_failed`: prioriteit: the list of allowed values is empty; asked by \[\w+\]/);
    assert.doesNotMatch(text, /person@example\.test/);
    assert.match(text, /builder_inspect_run/);
    assert.equal(calls.limit, 10);
    assert.deepEqual(calls.masked, [[STEPS.r2[1].error]], 'only the failed step\'s text goes to the mask, as a list');
});

test('detector down or unable to mask: the codes stay, the texts go', async () => {
    for (const detectPii of [async () => ({ degraded: true }), async () => null, async () => { throw new Error('guard down'); }, async () => ({ hasPii: true, entities: [] })]) {
        const { deps: d } = deps({ detectPii });
        const text = await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, d);
        assert.match(text, /- `ai` \(ai_step\) failed with code `ai_checks_failed`\n/);
        assert.doesNotMatch(text, /prioriteit|person@example/);
    }
});

test('a run the session already knows is not repeated', async () => {
    const { deps: d, calls } = deps();
    assert.equal(await lastRunBlock({ automationId: 'a1', userId: 'u1', since: '2026-11-04T12:00:00.000Z', canInspect: true }, d), null);
    assert.deepEqual(calls.steps, [], 'no step rows read');
});

test('only the owner, and only a run whose data they may read', async () => {
    const other = deps({ owner: 'someone-else' });
    assert.equal(await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, other.deps), null);
    assert.equal(other.calls.runs, 0);

    // A newer run on its starter's own connections belongs to that starter: the next one is read.
    const callerRun = { ...RUN, id: 'r3', connectionsMode: 'caller', startedByUserId: 'u2', startedAt: '2026-11-04T11:58:00.000Z', finishedAt: '2026-11-04T11:58:01.000Z' };
    const { deps: d, calls } = deps({ runs: [callerRun, RUN] });
    const text = await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, d);
    assert.deepEqual(calls.steps, ['r2']);
    assert.match(text, /- `ai`/);
});

test('no automation, no runs, no steps, a store failure: no block', async () => {
    assert.equal(await lastRunBlock({ automationId: null, userId: 'u1', since: SINCE, canInspect: true }, deps().deps), null);
    assert.equal(await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, deps({ runs: [] }).deps), null);
    assert.equal(await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, deps({ steps: {} }).deps), null);
    const broken = deps({ store: { async listRunsForAutomation() { throw new Error('db down'); } } });
    assert.equal(await lastRunBlock({ automationId: 'a1', userId: 'u1', since: SINCE, canInspect: true }, broken.deps), null);
    assert.match(broken.calls.warned[0], /last run left out: db down/);
});
