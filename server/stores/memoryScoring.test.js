/**
 * The ranking maths, and the one assertion that ties it back to the prompt.
 *
 * THE HEADLINE TEST is "the budget measures what the prompt will contain".
 * `selectWithinBudget` counted `content.length` while `formatMemoriesForPrompt`
 * emitted `subject: attribute = value` for person/project rows and
 * `attribute: value` for preferences. The budget was measuring one string and
 * the prompt carrying another, so the memory block could overrun its share of
 * the context on exactly the types whose canonical form differs most from
 * their content. Rather than assert a hardcoded number, this file renders both
 * and compares them — so the two cannot drift apart again without failing.
 *
 * `../db` is stubbed through require.cache so importing memoryStore does not
 * open a connection; every function exercised here is pure.
 *
 * Run: cd server && node --test stores/memoryScoring.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stub the database before memoryStore's module-level initDB() ──────
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        pool: { connect: async () => { throw new Error('no db in this test'); } },
        run: async () => ({ rowCount: 0 }),
        getOne: async () => null,
        getAll: async () => [],
        exec: async () => {},
        getClient: async () => { throw new Error('no db in this test'); },
        withTransaction: async () => { throw new Error('no db in this test'); },
        makeStoreInit: (_tag, schemaFn) => schemaFn,
        getRedis: () => null,
    },
};

const {
    renderedLength, renderedBullet, rrfFuse, finalScore,
    TYPE_BASE_SCORES, LEG_WEIGHTS,
} = require('./memoryScoring');
const { formatMemoriesForPrompt } = require('./memoryStore');

// ── The budget must measure the prompt ───────────────────────────────

const CASES = [
    {
        label: 'person with a canonical key',
        memory: { type: 'person', subject: 'anna', attribute: 'role', value: 'CTO', content: 'Anna is the CTO of the company and joined in 2019' },
    },
    {
        label: 'project with a canonical key',
        memory: { type: 'project', subject: 'beeflow', attribute: 'stack', value: 'Node 22', content: 'The Bee Flow backend runs on Node 22 with Express 5' },
    },
    {
        label: 'preference with a canonical key',
        memory: { type: 'preference', subject: 'user', attribute: 'language', value: 'Dutch', content: 'The user prefers to be answered in Dutch' },
    },
    {
        label: 'instruction (no canonical form)',
        memory: { type: 'instruction', content: 'Always answer concisely' },
    },
    {
        label: 'fact (no canonical form)',
        memory: { type: 'fact', subject: 'x', attribute: 'y', value: 'z', content: 'A plain fact' },
    },
    {
        label: 'person missing its value falls back to content',
        memory: { type: 'person', subject: 'bob', attribute: 'role', value: null, content: 'Bob works here' },
    },
];

for (const { label, memory } of CASES) {
    test(`renderedLength matches what the prompt emits — ${label}`, () => {
        const prompt = formatMemoriesForPrompt([memory]);
        const bullet = renderedBullet(memory);
        assert.ok(
            prompt.includes(bullet),
            `formatMemoriesForPrompt did not emit ${JSON.stringify(bullet)}\n--- prompt ---\n${prompt}`,
        );
        assert.strictEqual(renderedLength(memory), bullet.length);
    });
}

test('a canonical preference is measured shorter than its content', () => {
    // The concrete shape of the old bug: 39 characters of content, 24 of
    // rendered bullet. The budget was reserving space for text that never
    // reached the prompt.
    const memory = CASES[2].memory;
    assert.ok(renderedLength(memory) < memory.content.length);
});

// ── RRF fusion ───────────────────────────────────────────────────────

test('a document ranked by every leg beats one ranked by a single leg', () => {
    const fused = rrfFuse([
        { key: 'vec', ids: ['a', 'b'] },
        { key: 'fts', ids: ['a', 'c'] },
        { key: 'base', ids: ['a', 'd'] },
    ]);
    const a = fused.get('a');
    assert.ok(a > fused.get('b'));
    assert.ok(a > fused.get('c'));
    assert.ok(a > fused.get('d'));
});

test('leg weights order ties: vec outranks fts outranks base', () => {
    // Same rank position in each leg, so only the weight separates them.
    const fused = rrfFuse([
        { key: 'vec', ids: ['v'] },
        { key: 'fts', ids: ['f'] },
        { key: 'base', ids: ['b'] },
    ]);
    assert.ok(fused.get('v') > fused.get('f'));
    assert.ok(fused.get('f') > fused.get('b'));
    assert.ok(LEG_WEIGHTS.vec > LEG_WEIGHTS.fts && LEG_WEIGHTS.fts > LEG_WEIGHTS.base);
});

test('rank position matters within a leg', () => {
    const fused = rrfFuse([{ key: 'vec', ids: ['first', 'second', 'third'] }]);
    assert.ok(fused.get('first') > fused.get('second'));
    assert.ok(fused.get('second') > fused.get('third'));
});

test('a missing or malformed leg is skipped, not fatal', () => {
    const fused = rrfFuse([null, { key: 'vec' }, { key: 'base', ids: ['x'] }]);
    assert.strictEqual(fused.size, 1);
    assert.ok(fused.get('x') > 0);
});

test('an empty fusion produces no scores rather than throwing', () => {
    assert.strictEqual(rrfFuse([]).size, 0);
    assert.strictEqual(rrfFuse(undefined).size, 0);
});

// ── finalScore ───────────────────────────────────────────────────────

test('the fused score can lift a low-value type above a high-value one', () => {
    // The point of hybrid retrieval: a directly relevant `fact` should beat a
    // `context` row that matched nothing, despite the type base scores.
    const now = Date.now();
    const relevantFact = finalScore({ type: 'fact', updated_at: new Date(now), importance: 0.5 }, 0.04, { now });
    const irrelevantPerson = finalScore({ type: 'person', updated_at: new Date(now), importance: 0.5 }, 0, { now });
    assert.ok(relevantFact > irrelevantPerson);
});

test('a relevance signal clears the budget pass\'s score > 30 floor', () => {
    // `selectWithinBudget` drops anything at or below 30. A `context` memory
    // (base 20) that the vector leg ranked first must survive that floor, or
    // hybrid retrieval would find rows it then silently discards.
    const now = Date.now();
    const topRanked = LEG_WEIGHTS.vec / 61;
    const score = finalScore({ type: 'context', updated_at: new Date(now), importance: 0.5 }, topRanked, { now });
    assert.ok(score > 30, `expected > 30, got ${score}`);
});

test('recency decays and is capped, so freshness cannot outweigh relevance', () => {
    const now = Date.now();
    const day = 86_400_000;
    const fresh = finalScore({ type: 'fact', updated_at: new Date(now), importance: 0.5 }, 0, { now });
    const week = finalScore({ type: 'fact', updated_at: new Date(now - 7 * day), importance: 0.5 }, 0, { now });
    const year = finalScore({ type: 'fact', updated_at: new Date(now - 365 * day), importance: 0.5 }, 0, { now });

    assert.ok(fresh > week && week > year);
    // The bonus bottoms out rather than going negative.
    assert.strictEqual(year, TYPE_BASE_SCORES.fact + 0.5 * 20);
    // And it is worth at most 20 points, less than a strong relevance hit.
    assert.ok(fresh - year <= 20);
});

test('an unknown type scores rather than producing NaN', () => {
    const score = finalScore({ type: 'something_new', updated_at: new Date(), importance: 0.5 }, 0.01);
    assert.ok(Number.isFinite(score) && score > 0);
});

test('a memory with no timestamps or importance still scores', () => {
    const score = finalScore({ type: 'fact' }, 0);
    assert.ok(Number.isFinite(score));
});
