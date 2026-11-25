// @typecheck
/**
 * An item's receipts for its owner (./coworkReceipts.mts): the chain newest first with its verdict, the runs that are
 * still without a receipt after the grace time, one run's receipt, and the public key.
 *
 * Run: cd server && node --test usecases/coworkReceipts.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { receiptsOf, receiptOfRun, publicReceiptKey, GRACE_MS } = require('./coworkReceipts.mts');

const ITEM = { id: 's1', userId: 'u1' };
const deps = (over = {}) => ({
    listReceipts: async () => [],
    receiptOfRun: async () => null,
    countMissing: async () => 0,
    signingKey: async () => null,
    ...over,
});

test('an empty chain holds; a run closed longer ago than the grace time without a receipt counts as missing', async () => {
    const now = new Date('2026-11-23T10:00:00Z');
    /** @type {Date[]} */
    const asked = [];
    const view = await receiptsOf(ITEM, now, deps({ countMissing: async (/** @type {string} */ _id, /** @type {Date} */ before) => { asked.push(before); return 2; } }));
    assert.deepStrictEqual([view.verdict.ok, view.verdict.count, view.missingRuns, view.keyId], [true, 0, 2, null]);
    assert.strictEqual(asked[0].getTime(), now.getTime() - GRACE_MS);
});

test('a run without a receipt is a 404; without a key there is no public key to hand out', async () => {
    await assert.rejects(receiptOfRun(ITEM, 'r1', deps()), (err) => /** @type {any} */ (err).status === 404);
    assert.strictEqual(await publicReceiptKey(deps()), null);
});
