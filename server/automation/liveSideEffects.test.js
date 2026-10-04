/**
 * automation/liveSideEffects.js — the helpers save, activate, publish and the
 * go-live cores share. Built through makeLiveSideEffects with injected
 * modules (no module mocking).
 *
 * Proven:
 *   - agentsFor and kbFindingsFor fail OPEN (null / []), and kbFindingsFor
 *     resolves a lazily given organisation inside that fail-open;
 *   - wakeComplianceReview queues after the current turn, prefers the row's
 *     organisation, falls back to the owner's, and swallows every failure;
 *   - ensureFormPages provisions one page per form trigger (primary = null);
 *   - ensureAnswersTable reports the table and its usage entry, or the error.
 *
 * Run: cd server && node --test automation/liveSideEffects.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeLiveSideEffects } = require('./liveSideEffects');
const defaults = require('./liveSideEffects');

const nextTurn = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('the module exports the default set', () => {
    for (const fn of ['agentsFor', 'kbFindingsFor', 'wakeComplianceReview', 'ensureFormPages', 'ensureAnswersTable']) {
        assert.strictEqual(typeof defaults[fn], 'function', fn);
    }
});

test('agentsFor asks the owner\'s catalog and fails open to null', async () => {
    const asked = [];
    const ok = makeLiveSideEffects({ agentCatalogForOwner: async (def, ownerId) => { asked.push(ownerId); return new Set(['ag1']); } });
    assert.deepStrictEqual([...await ok.agentsFor({}, 'owner')], ['ag1']);
    assert.deepStrictEqual(asked, ['owner']);
    const down = makeLiveSideEffects({ agentCatalogForOwner: async () => { throw new Error('db down'); } });
    assert.strictEqual(await down.agentsFor({}, 'owner'), null);
});

test('kbFindingsFor passes the organisation (value or lazy) and fails open to []', async () => {
    const seen = [];
    const fx = makeLiveSideEffects({ kbStepFindings: async (def, opts) => { seen.push(opts); return [{ code: 'kb.x' }]; } });
    assert.deepStrictEqual(await fx.kbFindingsFor({}, { orgId: 'org-1', userId: 'u1', stage: 'activate' }), [{ code: 'kb.x' }]);
    await fx.kbFindingsFor({}, { orgId: async () => 'org-lazy', userId: 'u1', stage: 'draft' });
    assert.deepStrictEqual(seen, [
        { orgId: 'org-1', userId: 'u1', stage: 'activate' },
        { orgId: 'org-lazy', userId: 'u1', stage: 'draft' },
    ]);
    // An organisation that cannot be resolved is the check's own failure: open.
    assert.deepStrictEqual(await fx.kbFindingsFor({}, { orgId: async () => { throw new Error('no org'); }, userId: 'u1', stage: 'draft' }), []);
    const down = makeLiveSideEffects({ kbStepFindings: async () => { throw new Error('kb down'); } });
    assert.deepStrictEqual(await down.kbFindingsFor({}, { orgId: 'org-1', userId: 'u1', stage: 'activate' }), []);
});

function complianceFixture({ users = {}, reviewThrows = false, lookupThrows = false } = {}) {
    const queued = [];
    const lookups = [];
    const fx = makeLiveSideEffects({
        userStore: { getUser: async (id) => { lookups.push(id); if (lookupThrows) throw new Error('users down'); return users[id] || null; } },
        subjectReview: { reviewAutomation: (orgId, id, opts) => { if (reviewThrows) throw new Error('queue exploded'); queued.push([orgId, id, opts.reason]); } },
    });
    return { fx, queued, lookups };
}

test('wakeComplianceReview queues on a LATER turn, in the row\'s organisation, without reading the owner', async () => {
    const { fx, queued, lookups } = complianceFixture({ users: { u1: { organizationId: 'org-owner' } } });
    fx.wakeComplianceReview({ id: 'a1', userId: 'u1', organizationId: 'org-row' }, 'activation');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(queued, [], 'nothing in the current turn: the response goes first');
    await nextTurn();
    assert.deepStrictEqual(queued, [['org-row', 'a1', 'activation']]);
    assert.deepStrictEqual(lookups, [], 'a stamped row answers the question by itself');
});

test('wakeComplianceReview falls back to the owner\'s organisation, and queues nothing without one', async () => {
    const owner = complianceFixture({ users: { u1: { organizationId: 'org-owner' } } });
    owner.fx.wakeComplianceReview({ id: 'a1', userId: 'u1', organizationId: null }, 'publish');
    await nextTurn();
    assert.deepStrictEqual(owner.queued, [['org-owner', 'a1', 'publish']]);

    const none = complianceFixture();
    none.fx.wakeComplianceReview({ id: 'a2', userId: 'u1' }, 'deactivation');
    await nextTurn();
    assert.deepStrictEqual(none.queued, []);
});

test('wakeComplianceReview swallows a failing queue and a failing lookup', async () => {
    const boom = complianceFixture({ reviewThrows: true });
    assert.doesNotThrow(() => boom.fx.wakeComplianceReview({ id: 'a1', organizationId: 'org' }, 'activation'));
    const lookup = complianceFixture({ lookupThrows: true });
    lookup.fx.wakeComplianceReview({ id: 'a2', userId: 'u1' }, 'activation');
    await nextTurn();
    assert.deepStrictEqual(lookup.queued, [], 'nothing queued against a guessed organisation');
});

test('ensureFormPages provisions the primary form (null) and every extra form trigger, best-effort', async () => {
    const made = [];
    const fx = makeLiveSideEffects({
        automationStore: { ensureFormPage: async (id, stepId) => { if (stepId === 'bad') throw new Error('x'); made.push([id, stepId]); } },
    });
    await fx.ensureFormPages('a1', {
        trigger: { id: 't1', kind: 'form' },
        triggers: [{ id: 't2', kind: 'form' }, { id: 't3', kind: 'webhook' }, { kind: 'form' }, { id: 'bad', kind: 'form' }],
    });
    assert.deepStrictEqual(made, [['a1', null], ['a1', 't2']]);
    made.length = 0;
    await fx.ensureFormPages('a1', { trigger: { id: 't1', kind: 'manual' } });
    assert.deepStrictEqual(made, []);
});

test('ensureAnswersTable reports the table and its usage entry, a missing table, or the failure', async () => {
    const created = makeLiveSideEffects({ formAnswers: { ensureAnswersTable: async () => ({ table: { id: 'dt1' }, created: true, changed: false, warnings: ['w'] }) } });
    assert.deepStrictEqual(await created.ensureAnswersTable({ id: 'a1' }, {}), {
        answers: { datatableId: 'dt1', created: true, changed: false, warnings: ['w'] },
        usage: [{ datatableId: 'dt1', stepId: 'trigger:form', mode: 'write', columns: [] }],
    });

    const none = makeLiveSideEffects({ formAnswers: { ensureAnswersTable: async () => null } });
    assert.deepStrictEqual(await none.ensureAnswersTable({ id: 'a1' }, {}), { answers: null, usage: [] });

    const noTable = makeLiveSideEffects({ formAnswers: { ensureAnswersTable: async () => ({ table: null, error: { code: 'x' } }) } });
    assert.deepStrictEqual(await noTable.ensureAnswersTable({ id: 'a1' }, {}),
        { answers: { datatableId: null, created: false, changed: false, error: { code: 'x' } }, usage: [] });

    const down = makeLiveSideEffects({ formAnswers: { ensureAnswersTable: async () => { throw new Error('db down'); } } });
    assert.deepStrictEqual(await down.ensureAnswersTable({ id: 'a1' }, {}),
        { answers: { datatableId: null, created: false, changed: false, error: { code: 'provision_failed', message: 'db down' } }, usage: [] });
});
