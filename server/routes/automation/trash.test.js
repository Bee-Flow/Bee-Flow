/**
 * The automation trash: DELETE /:id (soft), GET /_trash, POST /:id/restore,
 * and the purge job that ends it. Handlers and job take their store by
 * injection — no module mocking.
 *
 * Run: cd server && node --test routes/automation/trash.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeTrashHandlers, purgeAtOf } = require('./trash');
const { purgeTrashPass } = require('../../jobs/automationTrashPurge');

function fakeStore(rows) {
    const byId = new Map(rows.map(r => [r.id, { ...r }]));
    const calls = { revoked: [], subsDeleted: [], purged: [] };
    return {
        calls,
        byId,
        async getAutomation(id, { includeDeleted = false } = {}) {
            const a = byId.get(id);
            if (!a) return null;
            if (a.deletedAt && !includeDeleted) return null;
            return { ...a };
        },
        async deleteSubscriptionsForAutomation(id) { calls.subsDeleted.push(id); },
        async trashAutomation(id, by) {
            const a = byId.get(id);
            if (!a || a.deletedAt) return null;
            Object.assign(a, { deletedAt: '2026-09-01T10:00:00.000Z', deletedBy: by, isActive: false });
            return { ...a };
        },
        async restoreAutomation(id) {
            const a = byId.get(id);
            if (!a || !a.deletedAt) return null;
            Object.assign(a, { deletedAt: null, deletedBy: null, isActive: false });
            return { ...a };
        },
        async listTrash(userId) {
            return [...byId.values()].filter(a => a.userId === userId && a.deletedAt).map(a => ({ ...a, purgeAt: purgeAtOf(a.deletedAt) }));
        },
        async listPurgeableTrash() {
            return [...byId.values()].filter(a => a.deletedAt).map(a => ({ id: a.id, userId: a.userId }));
        },
        async purgeTrashedAutomation(id) {
            const a = byId.get(id);
            if (!a || !a.deletedAt) return false;
            byId.delete(id);
            calls.purged.push(id);
            return true;
        },
    };
}

function call(handler, { params = {}, user = 'u1' } = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        handler({ params, session: { user: { id: user } } }, res);
    });
}

function handlers(store) {
    const woke = [];
    const h = makeTrashHandlers({
        store,
        revokeRemoteSubscriptions: async (id) => { store.calls.revoked.push(id); },
        wakeComplianceReview: (a, reason) => woke.push(reason),
    });
    return { ...h, woke };
}

test('DELETE moves the routine into the trash: switched off, subscriptions gone, purge date given', async () => {
    const store = fakeStore([{ id: 'a1', userId: 'u1', isActive: true }]);
    const h = handlers(store);
    const r = await call(h.trash, { params: { id: 'a1' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.automation.isActive, false);
    assert.strictEqual(r.body.purgeAt, '2026-10-01T10:00:00.000Z');
    assert.deepStrictEqual(store.calls.revoked, ['a1']);
    assert.deepStrictEqual(store.calls.subsDeleted, ['a1']);
    assert.deepStrictEqual(h.woke, ['deactivation']);
    // Gone from ordinary reads.
    assert.strictEqual(await store.getAutomation('a1'), null);
});

test('DELETE: 404 unknown, 403 someone else\'s — nothing touched', async () => {
    const store = fakeStore([{ id: 'a1', userId: 'u1', isActive: true }]);
    const h = handlers(store);
    assert.strictEqual((await call(h.trash, { params: { id: 'x' } })).status, 404);
    assert.strictEqual((await call(h.trash, { params: { id: 'a1' }, user: 'u2' })).status, 403);
    assert.deepStrictEqual(store.calls.revoked, []);
});

test('GET /_trash lists only the caller\'s trashed routines', async () => {
    const store = fakeStore([
        { id: 'a1', userId: 'u1', deletedAt: '2026-09-01T10:00:00.000Z' },
        { id: 'a2', userId: 'u1' },
        { id: 'b1', userId: 'u2', deletedAt: '2026-09-01T10:00:00.000Z' },
    ]);
    const r = await call(handlers(store).listTrash);
    assert.deepStrictEqual(r.body.automations.map(a => a.id), ['a1']);
    assert.strictEqual(r.body.retentionDays, 30);
});

test('restore brings a trashed routine back paused; 404 when it is not in the trash', async () => {
    const store = fakeStore([{ id: 'a1', userId: 'u1', isActive: false, deletedAt: '2026-09-01T10:00:00.000Z' }, { id: 'a2', userId: 'u1' }]);
    const h = handlers(store);
    assert.strictEqual((await call(h.restore, { params: { id: 'a1' }, user: 'u2' })).status, 403);
    const r = await call(h.restore, { params: { id: 'a1' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.automation.deletedAt, null);
    assert.strictEqual(r.body.automation.isActive, false);
    const again = await call(h.restore, { params: { id: 'a2' } });
    assert.strictEqual(again.status, 404);
    assert.strictEqual(again.body.code, 'not_in_trash');
});

test('purge: releases answers tables, deletes, and cleans both usage indexes', async () => {
    const store = fakeStore([{ id: 'a1', userId: 'u1', deletedAt: '2026-08-01T00:00:00.000Z' }]);
    const released = []; const dt = []; const app = [];
    const out = await purgeTrashPass({
        store,
        releaseAnswersTables: async (a) => released.push(a.id),
        purgeDatatableUsage: async (id) => dt.push(id),
        purgeAppUsage: async (id) => app.push(id),
    });
    assert.deepStrictEqual(out, { purged: 1, considered: 1 });
    assert.deepStrictEqual(released, ['a1']);
    assert.deepStrictEqual(store.calls.purged, ['a1']);
    assert.deepStrictEqual(dt, ['a1']);
    assert.deepStrictEqual(app, ['a1']);
});

test('purge: a routine whose answers tables cannot be released is kept for the next pass', async () => {
    const store = fakeStore([{ id: 'a1', userId: 'u1', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'a2', userId: 'u1', deletedAt: '2026-08-01T00:00:00.000Z' }]);
    const out = await purgeTrashPass({
        store,
        releaseAnswersTables: async (a) => { if (a.id === 'a1') throw new Error('datatable store down'); },
        purgeDatatableUsage: async () => {},
        purgeAppUsage: async () => {},
    });
    assert.strictEqual(out.purged, 1);
    assert.deepStrictEqual(store.calls.purged, ['a2']);
    assert.ok(store.byId.has('a1'), 'kept, not half-deleted');
});
