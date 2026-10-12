'use strict';

/**
 * The write pipeline's decision table, with injected dependencies (no module
 * mocks): hard drops, Art. 9, canonical key, similarity bands, explicit wins,
 * cap.
 *
 * Run: cd server && node --test agents/memory/memoryWriter.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryWriter, detectSensitiveIdentifier, looksArt9 } = require('./memoryWriter');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function harness(over = {}) {
    const calls = { create: [], confirm: [], supersede: [], cap: [], judge: [] };
    let seq = 0;
    const deps = {
        log: silent,
        createMemory: async (...args) => { calls.create.push(args); return `new-${++seq}`; },
        findByKey: async () => null,
        findSimilarMemories: async () => [],
        confirm: async (id) => { calls.confirm.push(id); },
        supersede: async (o, n) => { calls.supersede.push([o, n]); return 1; },
        enforceCap: async (u, n) => { calls.cap.push([u, n]); return 0; },
        isSensitiveOptInForUser: async () => false,
        getMaxPerUser: async () => 1000,
        judge: async (a) => { calls.judge.push(a); return { decision: 'new', targetId: '' }; },
        ...over,
    };
    return { calls, writer: createMemoryWriter(deps) };
}

const CTX = { userId: 'u1', orgId: 'o1', agentId: null, projectId: null, conversationId: 'c1', origin: 'inferred' };
const fact = (over = {}) => ({ type: 'preference', content: 'Prefers short replies', importance: 0.7, ...over });

describe('hard drops', () => {
    for (const [label, text] of [
        ['IBAN', 'Pays from NL91 ABNA 0417 1643 00'],
        ['card number', 'Card is 4111 1111 1111 1111'],
        ['BSN', 'Mijn BSN is 123456782'],
        ['US SSN', 'SSN 123-45-6789'],
        ['password', 'The wifi password is hunter2hunter2'],
        ['API key', 'Uses key sk-abcdefghijklmnop12345678'],
    ]) {
        test(`${label} is never stored`, async () => {
            const { writer, calls } = harness();
            const r = await writer.writeMemory(fact({ content: text }), CTX);
            assert.deepEqual(r, { action: 'rejected', reason: 'sensitive_identifier' });
            assert.equal(calls.create.length, 0);
        });
    }

    test('ordinary numbers and the word password are fine', () => {
        assert.equal(detectSensitiveIdentifier('Uses a password manager'), null);
        assert.equal(detectSensitiveIdentifier('Has 3 projects and 12 colleagues, call 020 123 4567'), null);
    });

    test('it also looks at the value and the evidence quote', async () => {
        const { writer } = harness();
        const r = await writer.writeMemory(fact({ value: 'NL91ABNA0417164300' }), CTX);
        assert.equal(r.reason, 'sensitive_identifier');
    });
});

describe('Art. 9', () => {
    test('marked art9 without consent is rejected', async () => {
        const { writer, calls } = harness();
        const r = await writer.writeMemory(fact({ content: 'Has a rare condition', sensitivity: 'art9' }), CTX);
        assert.deepEqual(r, { action: 'rejected', reason: 'art9_no_consent' });
        assert.equal(calls.create.length, 0);
    });

    test('the keyword net catches what the model missed (NL and EN)', async () => {
        for (const text of ['Heeft diabetes type 2', 'Is a practising Muslim', 'Stemt op de PvdA', 'Is lid van de vakbond FNV']) {
            assert.ok(looksArt9(text), text);
            const { writer, calls } = harness();
            const r = await writer.writeMemory(fact({ content: text }), CTX);
            assert.equal(r.reason, 'art9_no_consent', text);
            assert.equal(calls.create.length, 0);
        }
        assert.ok(!looksArt9('Prefers short replies'));
    });

    test('with consent it waits for review, flagged art9, also for the tool', async () => {
        for (const origin of ['inferred', 'tool']) {
            const { writer, calls } = harness({ isSensitiveOptInForUser: async () => true });
            const r = await writer.writeMemory(fact({ content: 'Has diabetes', subject: 'user', attribute: 'condition', value: 'diabetes' }), { ...CTX, origin });
            assert.equal(r.action, 'pending_review');
            assert.equal(r.reason, 'art9_review');
            const opts = calls.create[0][11];
            assert.equal(opts.status, 'pending_review');
            assert.equal(opts.sensitivity, 'art9');
            assert.equal(opts.origin, origin);
            assert.equal(calls.create[0][7], 'condition', 'keeps its canonical key (createMemory supersedes only for an active row)');
            assert.equal(opts.confidence, 0.8);
        }
    });
});

describe('Art. 9 never goes into a shared pool', () => {
    test('a flagged candidate in a project chat is written to the personal scope, agent kept', async () => {
        const { writer, calls } = harness({ isSensitiveOptInForUser: async () => true });
        const r = await writer.writeMemory(fact({ content: 'Has a rare condition', sensitivity: 'art9' }), { ...CTX, projectId: 'p1', agentId: 'a1' });
        assert.equal(r.action, 'pending_review');
        assert.equal(calls.create[0][1], 'a1');
        assert.equal(calls.create[0][10], null, 'project_id NULL');
    });

    test('the keyword net does the same', async () => {
        const { writer, calls } = harness({ isSensitiveOptInForUser: async () => true });
        await writer.writeMemory(fact({ content: 'Heeft diabetes' }), { ...CTX, projectId: 'p1' });
        assert.equal(calls.create[0][10], null);
        assert.equal(calls.create[0][11].sensitivity, 'art9');
    });

    test('a non-sensitive candidate keeps its project', async () => {
        const { writer, calls } = harness();
        await writer.writeMemory(fact(), { ...CTX, projectId: 'p1' });
        assert.equal(calls.create[0][10], 'p1');
    });
});

describe('imported origin', () => {
    test('hard drops, art9 consent and pending apply, and the reasons are reported', async () => {
        const imp = { ...CTX, origin: 'imported' };
        const a = harness();
        assert.deepEqual(await a.writer.writeMemory(fact({ content: 'IBAN NL91 ABNA 0417 1643 00' }), imp), { action: 'rejected', reason: 'sensitive_identifier' });
        assert.deepEqual(await a.writer.writeMemory(fact({ content: 'Has diabetes' }), imp), { action: 'rejected', reason: 'art9_no_consent' });
        const b = harness({ isSensitiveOptInForUser: async () => true });
        const r = await b.writer.writeMemory(fact({ content: 'Has diabetes' }), imp);
        assert.equal(r.action, 'pending_review');
        assert.equal(b.calls.create[0][11].origin, 'imported');
        const c = harness({ getMaxPerUser: async () => 7 });
        assert.equal((await c.writer.writeMemory(fact(), imp)).action, 'created');
        assert.deepEqual(c.calls.cap, [['u1', 7]]);
        assert.equal(c.calls.create[0][11].origin, 'imported');
    });
});

describe('canonical key', () => {
    const keyed = fact({ content: 'Tom is a developer', subject: 'Tom', attribute: 'role', value: 'developer' });

    test('same value confirms, writes nothing', async () => {
        const { writer, calls } = harness({ findByKey: async () => ({ id: 'old', value: 'Developer', origin: 'inferred' }) });
        assert.deepEqual(await writer.writeMemory(keyed, CTX), { action: 'confirmed', id: 'old' });
        assert.deepEqual(calls.confirm, ['old']);
        assert.equal(calls.create.length, 0);
    });

    test('another value supersedes: a new row, never an in-place edit', async () => {
        const { writer, calls } = harness({ findByKey: async () => ({ id: 'old', value: 'tester', origin: 'inferred' }) });
        const r = await writer.writeMemory(keyed, CTX);
        assert.deepEqual(r, { action: 'superseded', id: 'new-1', supersededId: 'old' });
        assert.equal(calls.create.length, 1, 'createMemory supersedes the old key itself');
        assert.equal(calls.create[0][7], 'role');
        assert.equal(calls.cap.length, 1);
    });

    test('an inferred value never replaces an explicit one: it waits for review', async () => {
        const { writer, calls } = harness({ findByKey: async () => ({ id: 'mine', value: 'tester', origin: 'explicit' }) });
        const r = await writer.writeMemory(keyed, CTX);
        assert.equal(r.action, 'pending_review');
        assert.equal(r.reason, 'contradicts_explicit');
        assert.equal(calls.create[0][11].status, 'pending_review');
        assert.equal(calls.create[0][11].replacesId, 'mine', 'the pending row names the explicit row it would replace');
        assert.equal(calls.create[0][7], 'role');
        assert.equal(calls.supersede.length, 0);
    });

    test('an explicit write may replace an explicit one', async () => {
        const { writer } = harness({ findByKey: async () => ({ id: 'mine', value: 'tester', origin: 'explicit' }) });
        assert.equal((await writer.writeMemory(keyed, { ...CTX, origin: 'explicit' })).action, 'superseded');
    });
});

describe('no key: similarity bands', () => {
    const near = (similarity, over = {}) => async () => [{ id: 'm1', content: 'Prefers brief answers', similarity, origin: 'inferred', ...over }];

    test('cosine >= 0.92 is a duplicate', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(0.93, { cosine: 0.93, lexical: 0.5 }) });
        assert.deepEqual(await writer.writeMemory(fact(), CTX), { action: 'confirmed', id: 'm1' });
        assert.equal(calls.judge.length, 0);
    });

    test('the same normalised text is a duplicate without a vector', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(1, { content: '  prefers   SHORT replies ', cosine: null, lexical: 1 }) });
        assert.deepEqual(await writer.writeMemory(fact(), CTX), { action: 'confirmed', id: 'm1' });
        assert.equal(calls.judge.length, 0);
    });

    // Word overlap is ~1.0 for all of these, the meaning is the opposite.
    for (const [now, before] of [
        ['User is no longer vegetarian', 'User is vegetarian'],
        ['Prefers Java over Python', 'Prefers Python over Java'],
        ['No longer works at Acme', 'Works at Acme'],
    ]) {
        test(`lexical-only match is not a duplicate, the judge decides: "${now}" vs "${before}"`, async () => {
            const asked = [];
            const { writer, calls } = harness({
                findSimilarMemories: async () => [{ id: 'm1', content: before, similarity: 1, lexical: 1, cosine: null, origin: 'inferred' }],
                judge: async (a) => { asked.push(a); return { decision: 'contradiction', targetId: 'm1' }; },
            });
            const r = await writer.writeMemory(fact({ content: now }), CTX);
            assert.equal(asked.length, 1, 'the judge was asked');
            assert.deepEqual(r, { action: 'superseded', id: 'new-1', supersededId: 'm1' });
            assert.equal(calls.confirm.length, 0, 'not confirmed');
        });
    }

    test('a lexical-only match the judge calls new is stored, never confirmed', async () => {
        const { writer, calls } = harness({
            findSimilarMemories: async () => [{ id: 'm1', content: 'Works at Acme', similarity: 1, lexical: 1, cosine: 0.6, origin: 'inferred' }],
        });
        assert.equal((await writer.writeMemory(fact({ content: 'No longer works at Acme' }), CTX)).action, 'created');
        assert.equal(calls.confirm.length, 0);
    });

    test('< 0.80 is new, no model call', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(0.79) });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
        assert.equal(calls.judge.length, 0);
    });

    test('0.80-0.92: the model says duplicate', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(0.85), judge: async () => ({ decision: 'duplicate', targetId: 'm1' }) });
        assert.deepEqual(await writer.writeMemory(fact(), CTX), { action: 'confirmed', id: 'm1' });
        assert.equal(calls.create.length, 0);
    });

    test('0.80-0.92: the model says contradiction -> new row supersedes the target', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(0.85), judge: async () => ({ decision: 'contradiction', targetId: 'm1' }) });
        const r = await writer.writeMemory(fact(), CTX);
        assert.deepEqual(r, { action: 'superseded', id: 'new-1', supersededId: 'm1' });
        assert.deepEqual(calls.supersede, [['m1', 'new-1']]);
    });

    test('0.80-0.92: the model says new', async () => {
        const { writer } = harness({ findSimilarMemories: near(0.85) });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
    });

    test('0.80-0.92: a failing model fails open to a create', async () => {
        const { writer, calls } = harness({ findSimilarMemories: near(0.85), judge: async () => { throw new Error('llm down'); } });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
        assert.equal(calls.create.length, 1);
        assert.equal(calls.supersede.length, 0);
    });

    test('an unparseable model answer fails open too', async () => {
        const { writer } = harness({ findSimilarMemories: near(0.85), judge: async () => null });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
    });

    test('a failing similarity lookup creates', async () => {
        const { writer } = harness({ findSimilarMemories: async () => { throw new Error('db'); } });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
    });

    test('explicit wins: a contradiction of an explicit memory waits for review', async () => {
        const { writer, calls } = harness({
            findSimilarMemories: near(0.85, { origin: 'explicit' }),
            judge: async () => ({ decision: 'contradiction', targetId: 'm1' }),
        });
        const r = await writer.writeMemory(fact(), CTX);
        assert.equal(r.action, 'pending_review');
        assert.equal(r.conflictsWith, 'm1');
        assert.equal(calls.create[0][11].replacesId, 'm1', 'judge path: no key, the id is persisted on the pending row');
        assert.equal(calls.supersede.length, 0);
    });

    test('the lookup is scoped to the write scope and asks for five', async () => {
        let seen;
        const { writer } = harness({ findSimilarMemories: async (u, c, o) => { seen = { u, o }; return []; } });
        await writer.writeMemory(fact(), { ...CTX, projectId: 'p1', agentId: 'a1' });
        assert.deepEqual(seen, { u: 'u1', o: { projectId: 'p1', agentId: 'a1', limit: 5 } });
    });
});

describe('cap and batches', () => {
    test('a create enforces the org cap for the user', async () => {
        const { writer, calls } = harness({ getMaxPerUser: async () => 250 });
        await writer.writeMemory(fact(), CTX);
        assert.deepEqual(calls.cap, [['u1', 250]]);
    });

    test('a failing cap does not undo the write', async () => {
        const { writer } = harness({ enforceCap: async () => { throw new Error('x'); } });
        assert.equal((await writer.writeMemory(fact(), CTX)).action, 'created');
    });

    test('writeMany goes one by one and survives a failing candidate', async () => {
        let n = 0;
        const { writer } = harness({ createMemory: async () => { if (++n === 1) throw new Error('boom'); return `id-${n}`; } });
        const out = await writer.writeMany([fact(), fact({ content: 'Uses dark mode' })], CTX);
        assert.deepEqual(out.map((o) => o.action), ['rejected', 'created']);
    });

    test('content and the passed origin reach the store', async () => {
        const { writer, calls } = harness();
        await writer.writeMemory(fact(), { ...CTX, origin: 'tool' });
        const [userId, , type, content, , importance, , , , , , opts] = calls.create[0];
        assert.deepEqual([userId, type, content, importance], ['u1', 'preference', 'Prefers short replies', 0.7]);
        assert.deepEqual(opts, { origin: 'tool', sourceConversationId: 'c1', sensitivity: 'none', status: 'active', confidence: 0.8 });
    });
});
