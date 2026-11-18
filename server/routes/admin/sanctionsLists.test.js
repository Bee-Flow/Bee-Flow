'use strict';
/**
 * The platform admin's sanctions list routes: status per list (also for a list never imported),
 * "refresh now" starts one pass, the gate is the super-admin gate.
 * Run: cd server && node --test routes/admin/sanctionsLists.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeSanctionsListsRouter } = require('./sanctionsLists.mts');

async function serve(router, fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/sanctions-lists', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0);
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        return await fn(`http://127.0.0.1:${port}/api/admin/sanctions-lists`);
    } finally {
        server.close();
    }
}

function jobStub() {
    const state = { running: false, runs: /** @type {unknown[]} */ ([]) };
    return {
        state,
        job: () => ({
            isRunning: () => state.running,
            settings: () => ({ intervalHours: 24, timeoutMs: 1000, maxBytes: 1 }),
            runOnce: async (opts) => { state.runs.push(opts); state.running = true; return { ran: true, outcomes: [] }; },
        }),
    };
}

const statusRow = { id: 'eu_fsf', label: 'EU', status: 'error', entityCount: 5800, nameCount: 30000, lastAttemptAt: '2026-01-02T00:00:00.000Z', lastSuccessAt: '2026-01-01T00:00:00.000Z', replacedAt: '2026-01-01T00:00:00.000Z', lastError: 'the server answered HTTP 503', etag: null, lastModified: null, contentHash: null };

test('GET: every list, the stored status where there is one, never imported elsewhere', async () => {
    const { job } = jobStub();
    const router = makeSanctionsListsRouter({ requireSuperAdmin: (_q, _s, next) => next(), listStatus: async () => [statusRow], job, pepVersion: () => '2026-11-18' });
    await serve(router, async (base) => {
        const body = await (await fetch(base)).json();
        assert.strictEqual(body.lists.length, 5);
        const eu = body.lists.find((l) => l.id === 'eu_fsf');
        assert.strictEqual(eu.status, 'error');
        assert.strictEqual(eu.lastError, 'the server answered HTTP 503');
        assert.strictEqual(eu.entityCount, 5800);
        assert.strictEqual(body.lists.find((l) => l.id === 'nl_terrorism').status, 'never');
        assert.deepStrictEqual({ refreshing: body.refreshing, intervalHours: body.intervalHours, pep: body.pepFunctionsVersion }, { refreshing: false, intervalHours: 24, pep: '2026-11-18' });
    });
});

test('POST /refresh starts one forced pass; a second while it runs does not', async () => {
    const { job, state } = jobStub();
    const router = makeSanctionsListsRouter({ requireSuperAdmin: (_q, _s, next) => next(), listStatus: async () => [], job });
    await serve(router, async (base) => {
        const post = () => fetch(`${base}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const first = await post();
        assert.strictEqual(first.status, 202);
        assert.deepStrictEqual(await first.json(), { requested: true });
        assert.deepStrictEqual(await (await post()).json(), { requested: false, reason: 'running' });
        assert.deepStrictEqual(state.runs, [{ force: true }]);
        assert.strictEqual((await fetch(`${base}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' })).status, 400);
    });
});

test('the gate refuses before anything is read', async () => {
    let read = false;
    const router = makeSanctionsListsRouter({ requireSuperAdmin: (_q, res) => { res.status(403).json({ error: 'forbidden' }); }, listStatus: async () => { read = true; return []; }, job: jobStub().job });
    await serve(router, async (base) => {
        assert.strictEqual((await fetch(base)).status, 403);
        assert.strictEqual((await fetch(`${base}/refresh`, { method: 'POST' })).status, 403);
    });
    assert.strictEqual(read, false);
});
