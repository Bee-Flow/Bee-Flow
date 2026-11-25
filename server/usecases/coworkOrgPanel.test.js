// @typecheck
/**
 * The administrators' Organisation panel of Cowork (./coworkOrgPanel.mts): the organisation's AI spend this month for
 * the budget meter, and the receipt audit over every item of the organisation.
 *
 * Run: cd server && node --test usecases/coworkOrgPanel.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { orgOverview, receiptsAudit, AUDIT_ITEM_LIMIT } = require('./coworkOrgPanel.mts');

test('the overview names the organisation and counts euros from the 1st of the month; a cost that cannot be read is null', async () => {
    /** @type {Date[]} */
    const since = [];
    const deps = {
        orgOf: async (/** @type {string} */ id) => (id === 'u1' ? { id: 'org1', name: 'Northwind' } : null),
        orgCostSince: async (/** @type {string} */ _org, /** @type {Date} */ from) => { since.push(from); return { byCurrency: { EUR: 41.5, USD: 3 } }; },
    };
    const now = new Date(2026, 10, 24, 10);
    assert.deepStrictEqual(await orgOverview('u1', now, deps), { orgId: 'org1', name: 'Northwind', spent: 41.5 });
    assert.strictEqual(since[0].getTime(), new Date(2026, 10, 1).getTime());
    assert.strictEqual(await orgOverview('nobody', now, deps), null);
    assert.strictEqual((await orgOverview('u1', now, { ...deps, orgCostSince: async () => { throw new Error('no ledger'); } }))?.spent, null);
});

const auditDeps = (/** @type {string[]} */ ids) => ({
    itemIdsOfOrg: async (/** @type {string} */ _org, /** @type {number} */ limit) => ids.slice(0, limit),
    listReceipts: async () => [],
    receiptOfRun: async () => null,
    countMissing: async (/** @type {string} */ id) => (id === 'late' ? 2 : 0),
    signingKey: async () => null,
});

test('an organisation without receipts passes; a run still without a receipt makes the audit fail, naming counts only', async () => {
    const now = new Date('2026-11-24T10:00:00Z');
    const fine = await receiptsAudit('org1', now, auditDeps(['a', 'b']));
    assert.deepStrictEqual([fine.ok, fine.items, fine.receipts, fine.missing, fine.problems, fine.truncated, fine.checkedAt], [true, 2, 0, 0, [], false, now.toISOString()]);
    const late = await receiptsAudit('org1', now, auditDeps(['a', 'late']));
    assert.deepStrictEqual([late.ok, late.missing], [false, 2]);
});

test('more items than the audit reads are said, never hidden', async () => {
    const ids = Array.from({ length: AUDIT_ITEM_LIMIT + 1 }, (_, i) => `i${i}`);
    const audit = await receiptsAudit('org1', new Date(), auditDeps(ids));
    assert.deepStrictEqual([audit.items, audit.truncated], [AUDIT_ITEM_LIMIT, true]);
});
