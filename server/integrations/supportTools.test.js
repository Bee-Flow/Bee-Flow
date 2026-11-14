// @typecheck
/**
 * executeSupportTool dispatches by tool name: the thread context, the action
 * policy (level and budget), an unknown name, and read and action tools keep
 * their answers and writes. The stores are swapped per test for recording
 * fakes; nothing reaches a database.
 *
 * Run: cd server && node --test integrations/supportTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('../testUtils/routeHarness').recordDb();
const supportStore = require('../stores/supportStore');
const userStore = require('../stores/userStore');
const { executeSupportTool, makeActionPolicy } = require('./supportTools');

/** @type {Record<string, unknown>} */
const THREAD = { id: 't1', status: 'open', organization_id: 'o1', requester_email: 'r@example.test' };

/**
 * Swap store methods for the length of `fn`, recording every write.
 * @param {Record<string, (...a: any[]) => unknown>} overrides
 * @param {(writes: [string, any][]) => Promise<void>} fn
 */
async function withStores(overrides, fn) {
    /** @type {[string, any][]} */
    const writes = [];
    const fakes = /** @type {Record<string, (...a: any[]) => unknown>} */ ({
        getThread: async () => ({ ...THREAD }),
        updateThread: async (/** @type {string} */ _id, /** @type {any} */ patch) => { writes.push(['updateThread', patch]); },
        recordThreadEvent: async (/** @type {any} */ e) => { writes.push(['event', e.payload]); },
        listTags: async () => [{ name: 'Billing' }],
        addThreadTag: async (/** @type {string} */ _id, /** @type {string} */ tag) => { writes.push(['addThreadTag', tag]); },
        ...overrides,
    });
    /** @type {[any, string, unknown][]} */
    const saved = [];
    for (const [name, impl] of Object.entries(fakes)) {
        const store = name in userStore && !(name in supportStore) ? userStore : supportStore;
        saved.push([store, name, store[name]]);
        store[name] = impl;
    }
    try { await fn(writes); } finally { for (const [store, name, orig] of saved) store[name] = orig; }
}

/** @param {string} level */
const ctx = (level) => ({ supportThreadId: 't1', supportActionPolicy: makeActionPolicy({ actionLevel: level, budget: 2 }) });

test('no thread, an unknown name, and the read tools without an organisation', async () => {
    assert.deepEqual(await executeSupportTool('support_get_organization_info', {}, {}), { error: 'No support thread context available.' });
    await withStores({ getThread: async () => ({ ...THREAD, organization_id: null }) }, async () => {
        assert.deepEqual(await executeSupportTool('support_nope', {}, ctx('none')), { error: 'Unknown support tool: support_nope' });
        assert.equal(await executeSupportTool('support_get_organization_info', {}, ctx('none')), null);
        assert.equal(await executeSupportTool('support_get_subscription_status', {}, ctx('none')), null);
        assert.deepEqual(await executeSupportTool('support_search_knowledge_base', {}, ctx('none')), { error: 'query required' });
    });
});

test('the action policy: no level, a level without the tool, then a write, a tag and the budget', async () => {
    await withStores({}, async (writes) => {
        assert.deepEqual(await executeSupportTool('support_set_priority', { priority: 'high' }, ctx('none')), { error: 'Action tools are not enabled for this inbox.' });
        assert.match(String((await executeSupportTool('support_set_status', { status: 'resolved' }, ctx('low'))).error), /not permitted in the current reply mode \(level: low\)/);
        const c = ctx('low');
        assert.deepEqual(await executeSupportTool('support_set_priority', { priority: 'bogus' }, c), { error: 'invalid priority' });
        assert.deepEqual(await executeSupportTool('support_set_priority', { priority: 'HIGH' }, c), { ok: true, priority: 'high' });
        assert.deepEqual(await executeSupportTool('support_add_tag', { tag: 'billing' }, c), { ok: true, tag: 'Billing' });
        assert.deepEqual(await executeSupportTool('support_set_category', { category: 'x' }, c), { error: 'Action budget exhausted (max 2 per turn).' });
        assert.equal(c.supportActionPolicy.used, 2);
        assert.deepEqual(writes, [
            ['updateThread', { priority: 'high' }], ['event', { tool: 'support_set_priority', priority: 'high' }],
            ['addThreadTag', 'Billing'], ['event', { tool: 'support_add_tag', tag: 'Billing' }],
        ]);
    });
});

test('set_status: resolved only at full, with resolved_at, and the clobber signal', async () => {
    await withStores({}, async (writes) => {
        assert.match(String((await executeSupportTool('support_set_status', { status: 'resolved' }, ctx('mid'))).error), /^Status "resolved" not permitted/);
        const c = ctx('full');
        assert.deepEqual(await executeSupportTool('support_set_status', { status: 'resolved' }, c), { ok: true, status: 'resolved' });
        assert.equal(c.supportActionPolicy.statusChangedByTool, true);
        assert.equal(writes[0][1].status, 'resolved');
        assert.equal(typeof writes[0][1].resolved_at, 'string');
    });
});
