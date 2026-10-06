/**
 * The flatten step at run time (spec F29-F34): skip shapes, both caps, the
 * output envelope and the PII exemption.
 *
 * Run: node --test core/automationRunner/execCollections.flatten.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { execFlatten } = require('./execCollections');
const { PII_RESCAN_EXEMPT_TYPES, COLLECTION_OP_MAX_ITEMS } = require('./shared');
const { flattenMailRoot, flattenOrdersRoot, FLATTEN_MAIL_STEP } = require('../../shared/expr/corpus.mjs');

const ORDER_STEP = { id: 'fl', type: 'flatten', arrayRef: 'steps.http.output.body.orders[*].lines' };

test('Gmail: 64 rows from 4 messages, envelope keys in order and no dead/over', async () => {
    const r = await execFlatten(FLATTEN_MAIL_STEP, {}, flattenMailRoot());
    assert.strictEqual(r.skippedReason, undefined);
    assert.deepStrictEqual(Object.keys(r.output), ['items', 'count', 'inputCount', 'emptyCount']);
    assert.strictEqual(r.output.count, 64);
    assert.strictEqual(r.output.inputCount, 4);
    assert.strictEqual(r.output.emptyCount, 0);
    assert.strictEqual(r.output.items[0].subject, flattenMailRoot().steps.g_read_many.output.messages[0].subject);
});

test('the output never holds an array beside items (D9)', async () => {
    const r = await execFlatten(FLATTEN_MAIL_STEP, {}, flattenMailRoot());
    const arrays = Object.entries(r.output).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
    assert.deepStrictEqual(arrays, ['items']);
});

test('F29: an unresolved outer list is skipped as arrayref_unresolved, named by the outer list', async () => {
    const r = await execFlatten(FLATTEN_MAIL_STEP, {}, { steps: {} });
    assert.strictEqual(r.skippedReason, 'arrayref_unresolved');
    assert.deepStrictEqual(r.output.items, []);
    assert.strictEqual(r.output.count, 0);
    assert.match(r.output.skipped, /steps\.g_read_many\.output\.messages`/);
});

test('F30: an empty outer list is a success with zero counts', async () => {
    const r = await execFlatten(FLATTEN_MAIL_STEP, {}, { steps: { g_read_many: { output: { messages: [] } } } });
    assert.strictEqual(r.skippedReason, undefined);
    assert.deepStrictEqual(r.output, { items: [], count: 0, inputCount: 0, emptyCount: 0 });
});

test('F31: a route that fits nothing is skipped as flatten_no_match with the sentence', async () => {
    const root = { steps: { g_read_many: { output: { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] } } } };
    const r = await execFlatten(FLATTEN_MAIL_STEP, {}, root);
    assert.strictEqual(r.skippedReason, 'flatten_no_match');
    assert.deepStrictEqual(r.output, {
        items: [], count: 0, inputCount: 4, emptyCount: 4,
        skipped: 'None of the 4 messages has a list called attachments, so there was nothing to flatten. '
            + 'Re-run the step before this one, or pick another list in this step.',
    });
});

test('F32: more outer items than maxItems throws collection_too_large', async () => {
    await assert.rejects(execFlatten({ ...FLATTEN_MAIL_STEP, maxItems: 3 }, {}, flattenMailRoot()),
        (e) => e.errorClass === 'collection_too_large' && /4 items \(max 3\)/.test(e.message));
});

test('F33: more rows than the cap throws collection_too_large with the remedy', async () => {
    await assert.rejects(execFlatten({ ...FLATTEN_MAIL_STEP, maxItems: 10 }, {}, flattenMailRoot()),
        (e) => e.errorClass === 'collection_too_large'
            && e.message === 'This step would make more than 10 rows. Put a Filter or a Limit before it to make the list smaller.');
});

test('maxItems never raises the platform cap', async () => {
    const r = await execFlatten({ ...FLATTEN_MAIL_STEP, maxItems: COLLECTION_OP_MAX_ITEMS * 10 }, {}, flattenMailRoot());
    assert.strictEqual(r.output.count, 64);
});

test('orders: keepEmpty false drops the empty order and counts it', async () => {
    const r = await execFlatten(ORDER_STEP, {}, flattenOrdersRoot());
    assert.strictEqual(r.output.count, 8);
    assert.strictEqual(r.output.inputCount, 5);
    assert.strictEqual(r.output.emptyCount, 1);
});

test('orders: keepEmpty true keeps the empty order as one row with null line fields', async () => {
    const r = await execFlatten({ ...ORDER_STEP, keepEmpty: true }, {}, flattenOrdersRoot());
    assert.strictEqual(r.output.count, 9);
    const empty = r.output.items.find(row => row.number === 'CO-2026-0413');
    assert.strictEqual(empty.sku, null);
    assert.strictEqual(empty.orderId, 'o4');
});

test('orders as JSON text flatten the same as the object body', async () => {
    const a = await execFlatten(ORDER_STEP, {}, flattenOrdersRoot());
    const b = await execFlatten(ORDER_STEP, {}, flattenOrdersRoot({ asText: true }));
    assert.deepStrictEqual(b.output, a.output);
});

test('F34: flatten is exempt from the PII rescan', () => {
    assert.ok(PII_RESCAN_EXEMPT_TYPES.has('flatten'));
});

test('keepEmpty: Outlook mails that leave attachments out still make one row each, not a no-match skip', async () => {
    const step = { id: 'fl', type: 'flatten', arrayRef: 'steps.o.output.messages[*].attachments', keepEmpty: true };
    const root = { steps: { o: { output: { messages: [{ id: 'a', subject: 'x' }, { id: 'b', subject: 'y' }] } } } };
    const r = await execFlatten(step, {}, root);
    assert.strictEqual(r.skippedReason, undefined);
    assert.strictEqual(r.output.count, 2);
    assert.strictEqual(r.output.emptyCount, 2);
    const off = await execFlatten({ ...step, keepEmpty: false }, {}, root);
    assert.strictEqual(off.skippedReason, 'flatten_no_match');
});
