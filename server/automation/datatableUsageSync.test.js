/**
 * The datatable dependents index has to be written by EVERY save path.
 *
 * reconcileUsage is delete-then-insert keyed on automation_id, so a path that
 * skips it does not merely fail to add rows — it leaves the PREVIOUS
 * definition's rows standing. Only `PUT /api/automation/:id` ever called it, so
 * an automation that was created, imported, restored from a version, saved as a
 * reusable Step or built through the MCP builder carried an index describing
 * some other version of itself. Three surfaces read that index, including the
 * guard that refuses a destructive column drop.
 *
 * Run: cd server && node --test --test-force-exit automation/datatableUsageSync.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const { test, after } = require('node:test');
const { installResolveStub } = require('../testUtils/stubRequire');

const calls = [];
let reconcileImpl = async () => 1;

let AUTOMATIONS = {};

const restore = installResolveStub({
    '../stores/datatableStore': {
        orgScope: (id) => ({ kind: 'org', id }),
        userScope: (id) => ({ kind: 'user', id }),
        reconcileUsage: async (automationId, scope, entries) => {
            calls.push({ fn: 'reconcileUsage', automationId, scope, entries });
            return reconcileImpl(automationId, scope, entries);
        },
        purgeUsageForAutomation: async (automationId) => {
            calls.push({ fn: 'purgeUsageForAutomation', automationId });
            return 3;
        },
        reconcileUsageFor: async (consumerKind, consumerId, scope, entries) => {
            calls.push({ fn: 'reconcileUsageFor', consumerKind, consumerId, scope, entries });
            return reconcileImpl(consumerId, scope, entries);
        },
        purgeUsageFor: async (consumerKind, consumerId) => {
            calls.push({ fn: 'purgeUsageFor', consumerKind, consumerId });
            return 2;
        },
    },
    // Only reached when the automation has NO organisation — the personal-scope
    // path. Every caller that already knows the org skips this entirely.
    '../stores/automationStore': {
        getAutomation: async (id) => AUTOMATIONS[id] || null,
    },
});
after(restore);

const { syncDatatableUsage, purgeDatatableUsage, syncUsageFor, purgeUsageFor } = require('./datatableUsageSync');

const DEF = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 's1', type: 'datatable', op: 'find_rows', datatableId: 'tbl_a', where: [{ field: 'email' }] }],
    edges: [],
};

test('it collects the steps and hands them to the store with the automation\'s org', async () => {
    calls.length = 0;
    const written = await syncDatatableUsage('a1', 'orgA', DEF);
    assert.strictEqual(written, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].automationId, 'a1');
    assert.deepStrictEqual(calls[0].scope, { kind: 'org', id: 'orgA' });
    assert.deepStrictEqual(calls[0].entries.map(e => e.datatableId), ['tbl_a']);
});

test('an automation with NO organisation is indexed under its owner, not skipped', async () => {
    // Such an automation can only ever name that account's personal tables. Left
    // org-keyed it wrote nothing, so the "used by" panel and the destructive-
    // change guard were blind for every one of them.
    calls.length = 0;
    AUTOMATIONS = { a2: { id: 'a2', userId: 'u-solo' } };
    const written = await syncDatatableUsage('a2', null, DEF);
    assert.strictEqual(written, 1);
    assert.deepStrictEqual(calls[0].scope, { kind: 'user', id: 'u-solo' });
});

test('an automation with neither an organisation nor an owner is not indexed at all', async () => {
    calls.length = 0;
    AUTOMATIONS = {};
    const realWarn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        assert.strictEqual(await syncDatatableUsage('a3', null, DEF), 0);
    } finally {
        console.warn = realWarn;
    }
    assert.deepStrictEqual(calls, [], 'a scope-less reconcile would bind NULL and delete the old rows');
    assert.ok(warned.some(w => /no scope to index them under/.test(w)), warned.join('\n'));
});

test('a save that wrote NOTHING is reported, not counted as done', async () => {
    // The INSERT is guarded by `WHERE EXISTS (… organization_id = $1)`, so a
    // caller with the wrong org writes nothing and still returns success —
    // which is how the "used by" list on every table stayed empty on green
    // saves.
    calls.length = 0;
    reconcileImpl = async () => 0;
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        await syncDatatableUsage('a1', 'wrong-org', DEF, { label: 'test path' });
    } finally {
        console.warn = realWarn;
        reconcileImpl = async () => 1;
    }
    assert.ok(warned.some(w => /no usage rows written/.test(w)), warned.join('\n'));
});

test('it never throws — an index is not worth failing a save over', async () => {
    reconcileImpl = async () => { throw new Error('boom'); };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
        assert.strictEqual(await syncDatatableUsage('a1', 'orgA', DEF), -1);
    } finally {
        console.warn = realWarn;
        reconcileImpl = async () => 1;
    }
});

test('a deleted automation\'s rows are reaped through the store', async () => {
    calls.length = 0;
    assert.strictEqual(await purgeDatatableUsage('a1'), 3);
    assert.deepStrictEqual(calls, [{ fn: 'purgeUsageForAutomation', automationId: 'a1' }]);
});

// ── The other consumer kinds ────────────────────────────────────────────────

test('an app or webpage hands its own entries through, keyed on its kind', async () => {
    calls.length = 0;
    const entries = [{ datatableId: 'tbl_a', stepId: 'tbl_orders', mode: 'readwrite' }];
    const written = await syncUsageFor('app', 'app_1', { kind: 'org', id: 'orgA' }, entries, { label: 'app save' });
    assert.strictEqual(written, 1);
    assert.deepStrictEqual(calls, [{
        fn: 'reconcileUsageFor', consumerKind: 'app', consumerId: 'app_1',
        scope: { kind: 'org', id: 'orgA' }, entries,
    }]);
});

test('a consumer with no scope is not indexed, and says so when it had bindings', async () => {
    calls.length = 0;
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        assert.strictEqual(await syncUsageFor('webpage', 'page_1', null, [{ datatableId: 'tbl_a', stepId: 'b1' }]), 0);
        assert.strictEqual(await syncUsageFor('webpage', 'page_2', null, []), 0);
    } finally {
        console.warn = realWarn;
    }
    assert.deepStrictEqual(calls, [], 'a scope-less reconcile would bind NULL and delete the old rows');
    assert.strictEqual(warned.length, 1, 'only the page that HAD bindings is worth a line');
    assert.match(warned[0], /page_1.*no scope/);
});

test('the generic form never throws either, and reports a no-op write', async () => {
    reconcileImpl = async () => { throw new Error('boom'); };
    const realWarn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
        assert.strictEqual(await syncUsageFor('app', 'app_1', { kind: 'org', id: 'orgA' }, [{ datatableId: 't', stepId: 's' }]), -1);
        reconcileImpl = async () => 0;
        assert.strictEqual(await syncUsageFor('app', 'app_1', { kind: 'org', id: 'orgA' }, [{ datatableId: 't', stepId: 's' }]), 0);
    } finally {
        console.warn = realWarn;
        reconcileImpl = async () => 1;
    }
    assert.ok(warned.some(w => /reconcile failed/.test(w)));
    assert.ok(warned.some(w => /no usage rows written/.test(w)));
    assert.strictEqual(await syncUsageFor('app', '', { kind: 'org', id: 'orgA' }, []), -1, 'no id, nothing to key on');
});

test('a deleted app or webpage is reaped by kind', async () => {
    calls.length = 0;
    assert.strictEqual(await purgeUsageFor('webpage', 'page_1'), 2);
    assert.deepStrictEqual(calls, [{ fn: 'purgeUsageFor', consumerKind: 'webpage', consumerId: 'page_1' }]);
    assert.strictEqual(await purgeUsageFor('app', ''), 0);
});

// The "every save path calls it" property used to live here as a source-text
// scan over crud.js / versions.js / step.js / persistence.js. It is now
// asserted more broadly (every consumer kind, not just `automation`) in
// automation/usageSync.savePaths.test.js — 'every consumer kind the store
// knows has a save-path entry' and 'every listed file really makes the call'
// name the same four files for `automation`'s sync, and crud.js/step.js for
// its purge. Deleted here rather than duplicated.
