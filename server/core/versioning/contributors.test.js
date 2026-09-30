'use strict';

/**
 * Contributor lists (core/versioning/contributors.js): one shape for people
 * and the AI, merged without duplicates, ids only.
 *
 * Run: cd server && node --test core/versioning/contributors.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    normalizeContributor, mergeContributors, contributorsFromUserIds, hasAiContributor, MAX_CONTRIBUTORS,
} = require('./contributors');

test('normalises people and the AI, and drops what names nobody', () => {
    assert.deepStrictEqual(normalizeContributor({ userId: 'u1', kind: 'user', name: 'Anna' }), { userId: 'u1', kind: 'user' });
    assert.deepStrictEqual(normalizeContributor({ userId: 'u1' }), { userId: 'u1', kind: 'user' });
    assert.deepStrictEqual(normalizeContributor({ kind: 'ai', agentId: 'ag1', userId: 'u2' }), { userId: 'u2', kind: 'ai', agentId: 'ag1' });
    assert.deepStrictEqual(normalizeContributor({ kind: 'ai' }), { userId: null, kind: 'ai' });
    assert.strictEqual(normalizeContributor({ kind: 'user' }), null);
    assert.strictEqual(normalizeContributor({ kind: 'robot', userId: 'u1' }), null);
    assert.strictEqual(normalizeContributor('u1'), null);
    assert.strictEqual(normalizeContributor({ userId: 'x'.repeat(201) }), null);
});

test('merges lists in order, without duplicates, and caps the result', () => {
    const merged = mergeContributors(
        [{ userId: 'u1', kind: 'user' }, { kind: 'ai', agentId: 'ag' }],
        [{ userId: 'u1' }, { userId: 'u2', kind: 'user' }, { kind: 'ai', agentId: 'ag' }, null],
        'not a list',
    );
    assert.deepStrictEqual(merged, [
        { userId: 'u1', kind: 'user' },
        { userId: null, kind: 'ai', agentId: 'ag' },
        { userId: 'u2', kind: 'user' },
    ]);
    const many = Array.from({ length: 80 }, (_, i) => ({ userId: `u${i}` }));
    assert.strictEqual(mergeContributors(many).length, MAX_CONTRIBUTORS);
});

test('turns user ids into contributors and tells whether the AI took part', () => {
    assert.deepStrictEqual(contributorsFromUserIds(['a', 'a', 'b', '']), [
        { userId: 'a', kind: 'user' }, { userId: 'b', kind: 'user' },
    ]);
    assert.deepStrictEqual(contributorsFromUserIds(null), []);
    assert.strictEqual(hasAiContributor([{ kind: 'user', userId: 'a' }, { kind: 'ai' }]), true);
    assert.strictEqual(hasAiContributor([{ kind: 'user', userId: 'a' }]), false);
    assert.strictEqual(hasAiContributor(undefined), false);
});
