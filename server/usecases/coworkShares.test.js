// @typecheck
/**
 * Sharing a cowork (./coworkShares.mts): only colleagues of the owner's organisation, at most one who decides, and a
 * read-only view for the people it is shared with; anyone else, a member of another organisation included, gets the
 * same 404. Every part is handed in.
 *
 * Run: cd server && node --test usecases/coworkShares.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { setSharesFor, sharesOf, sharedWithMe, sharedItemOf } = require('./coworkShares.mts');

const PEOPLE = {
    ann: { id: 'ann', organizationId: 'org-a', displayName: 'Ann' },
    bob: { id: 'bob', organizationId: 'org-a', displayName: 'Bob' },
    cas: { id: 'cas', organizationId: 'org-a', displayName: 'Cas' },
    eve: { id: 'eve', organizationId: 'org-b', displayName: 'Eve' },
};
const ITEM = { id: 'w1', userId: 'ann', title: 'Supplier radar', prompt: 'Watch the supplier mail.', lastStatus: 'success', isActive: true };

function world() {
    /** @type {Map<string, any[]>} */
    const saved = new Map();
    return {
        saved,
        deps: {
            getUser: async (/** @type {string} */ id) => /** @type {any} */ (PEOPLE)[id] ?? null,
            listMembers: async (/** @type {string} */ org) => Object.values(PEOPLE).filter((p) => p.organizationId === org),
            shares: {
                listShares: async (/** @type {string} */ id) => saved.get(id) ?? [],
                setShares: async (/** @type {string} */ id, /** @type {any[]} */ shares) => { saved.set(id, shares); },
                sharedWith: async (/** @type {string} */ userId) => (saved.get('w1') ?? []).filter((s) => s.userId === userId).map((s) => ({ id: 'w1', ownerId: 'ann', title: 'Supplier radar', role: s.role, lastStatus: 'success', lastRunAt: null, isActive: true })),
                roleOf: async (/** @type {string} */ id, /** @type {string} */ userId) => (saved.get(id) ?? []).find((s) => s.userId === userId)?.role ?? null,
            },
            getSchedule: async (/** @type {string} */ id) => (id === 'w1' ? ITEM : null),
            listRuns: async () => [{ id: 'r1', status: 'success', startedAt: '2026-11-23T07:30:00Z', result: 'Three orders.', durationMs: 900 }],
        },
    };
}

test('the owner shares with colleagues of their own organisation, one of them deciding', async () => {
    const w = world();
    const shares = await setSharesFor({ item: ITEM, shares: [{ userId: 'bob', role: 'approver' }, { userId: 'cas', role: 'viewer' }] }, w.deps);
    assert.deepStrictEqual(shares, [{ userId: 'bob', role: 'approver', name: 'Bob' }, { userId: 'cas', role: 'viewer', name: 'Cas' }]);
    assert.deepStrictEqual(await sharesOf(ITEM, w.deps), shares);
    assert.deepStrictEqual((await sharedWithMe('bob', w.deps)).map((i) => [i.id, i.role, i.ownerName]), [['w1', 'approver', 'Ann']]);
});

test('a member of another organisation is never a share, and two who decide are refused', async () => {
    const w = world();
    await assert.rejects(setSharesFor({ item: ITEM, shares: [{ userId: 'eve', role: 'viewer' }] }, w.deps), (/** @type {any} */ e) => e.status === 404);
    await assert.rejects(setSharesFor({ item: ITEM, shares: [{ userId: 'bob', role: 'approver' }, { userId: 'cas', role: 'approver' }] }, w.deps), (/** @type {any} */ e) => e.status === 400);
    assert.strictEqual(w.saved.size, 0, 'nothing was saved');
});

test('someone it is shared with, and its owner, see it read only with its runs; anyone else gets a 404', async () => {
    const w = world();
    await setSharesFor({ item: ITEM, shares: [{ userId: 'cas', role: 'viewer' }] }, w.deps);
    const view = await sharedItemOf('cas', 'w1', w.deps);
    assert.deepStrictEqual([view.role, view.item.title, view.runs[0].result], ['viewer', 'Supplier radar', 'Three orders.']);
    assert.strictEqual((await sharedItemOf('ann', 'w1', w.deps)).role, 'owner');
    for (const outsider of ['eve', 'bob', 'nobody']) {
        await assert.rejects(sharedItemOf(outsider, 'w1', w.deps), (/** @type {any} */ e) => e.status === 404, outsider);
    }
    await assert.rejects(sharedItemOf('cas', 'no-such-item', w.deps), (/** @type {any} */ e) => e.status === 404);
});
