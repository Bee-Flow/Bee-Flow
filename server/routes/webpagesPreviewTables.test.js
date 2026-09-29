/**
 * routes/webpagesPreviewTables — de `window.beeflowTables`-brug.
 *
 * Geen databank en geen echte token: `requirePreviewToken`, de limiters, de
 * grant-lezer, de principal-resolver en de runner worden vóór het laden van de
 * router vervangen (ze worden daar gedestructureerd, dus later patchen komt te
 * laat). Wat overblijft is precies wat deze route zelf beslist: welke van de
 * twee poorten er dichtgaat, in welke volgorde, en met welke waarden de runner
 * wordt aangeroepen.
 *
 * Draaien: cd server && node --test --test-force-exit routes/webpagesPreviewTables.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

// ── stubs, vóór het laden van de router ──────────────────────────────
let CLAIMS = { userId: 'u-author', webpageId: 'wp1', viewerUserId: 'u-viewer' };
const previewToken = require('../auth/webpagePreviewToken');
previewToken.requirePreviewToken = (req, res, next) => { req.previewClaims = { ...CLAIMS }; next(); };

const limits = require('./webpagesPreviewRateLimits');
limits.tableReadBridgeLimiter = (req, res, next) => next();
limits.tableWriteBridgeLimiter = (req, res, next) => next();

let GRANTS = { ai: {}, automations: [], integrations: [], tables: [], agent: null };
const bridgeGrants = require('../stores/webpage/bridgeGrants');
bridgeGrants.getBridgeGrants = async () => GRANTS;

const dtAccess = require('../auth/datatableAccess');
const principalsAsked = [];
dtAccess.resolveDatatablePrincipalForUser = async (userId) => {
    principalsAsked.push(userId);
    return { userId, orgId: 'org-1', organizationId: 'org-1', orgRole: null, groupIds: [] };
};

const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const router = require('./webpagesPreviewTables');

// ── harnas ───────────────────────────────────────────────────────────
function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => { for (const [obj, key, orig] of originals) obj[key] = orig; });
}

async function withServer(t, fn) {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

function post(base, path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
}

const READ_BINDING = { datatableId: 'tbl_1', mode: 'read', columns: ['name', 'price'], publicColumns: ['name'] };
const RW_BINDING = { ...READ_BINDING, mode: 'readwrite' };

function resetClaims() {
    CLAIMS = { userId: 'u-author', webpageId: 'wp1', viewerUserId: 'u-viewer' };
}

// ── poort 1: de binding ──────────────────────────────────────────────

test('a table this page is not bound to is a 404, and the runner is never called', async (t) => {
    resetClaims();
    GRANTS = { tables: [READ_BINDING] };
    let resolved = false;
    await withPatches([[datatableRuntime, 'resolveForPrincipal', async () => { resolved = true; }]],
        () => withServer(t, async (base) => {
            const res = await post(base, '/wp1/tables/tbl_other/query');
            assert.strictEqual(res.status, 404);
            assert.strictEqual((await res.json()).code, 'table_not_bound');
            assert.strictEqual(resolved, false, 'no datatable may be opened for an unbound id');
        }));
});

test('BITE — a read-only binding refuses insert and update before anything is resolved', async (t) => {
    resetClaims();
    GRANTS = { tables: [READ_BINDING] };
    let resolved = false;
    await withPatches([[datatableRuntime, 'resolveForPrincipal', async () => { resolved = true; }]],
        () => withServer(t, async (base) => {
            for (const path of ['/wp1/tables/tbl_1/insert', '/wp1/tables/tbl_1/update']) {
                const res = await post(base, path, { values: { name: 'x' } });
                assert.strictEqual(res.status, 403, path);
                assert.strictEqual((await res.json()).code, 'binding_read_only', path);
            }
            assert.strictEqual(resolved, false, 'a read-only binding may not even open the table');
        }));
});

// ── poort 2: de bezoeker ─────────────────────────────────────────────

test('BITE — a token without a viewer claim is refused, never fallen back to the author', async (t) => {
    CLAIMS = { userId: 'u-author', webpageId: 'wp1' }; // token van vóór W3
    GRANTS = { tables: [RW_BINDING] };
    let resolved = false;
    await withPatches([[datatableRuntime, 'resolveForPrincipal', async () => { resolved = true; }]],
        () => withServer(t, async (base) => {
            const res = await post(base, '/wp1/tables/tbl_1/query');
            assert.strictEqual(res.status, 401);
            assert.strictEqual((await res.json()).code, 'viewer_unknown');
            assert.strictEqual(resolved, false);
            assert.strictEqual(principalsAsked.includes('u-author'), false,
                'the page author must never be used as the reader');
        }));
});

test('the read runs as the VIEWER, with the binding columns as the allow-list', async (t) => {
    resetClaims();
    GRANTS = { tables: [READ_BINDING] };
    principalsAsked.length = 0;
    let seenPrincipal = null;
    let seenOpts = null;
    await withPatches([
        [datatableRuntime, 'resolveForPrincipal', async (id, p, opts) => {
            seenPrincipal = p; seenOpts = opts;
            return { table: { id }, grade: 'viewer', principal: p };
        }],
        [datatableRuntime, 'readRows', async (_r, opts) => {
            seenOpts = { ...seenOpts, read: opts };
            return { rows: [{ id: 'r1', name: 'a', updated_at: 't' }], hasMore: false, count: 1, nextCursor: null, columns: ['name', 'price'] };
        }],
    ], () => withServer(t, async (base) => {
        const res = await post(base, '/wp1/tables/tbl_1/query', { limit: 5 });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.rows.length, 1);
        assert.strictEqual(seenPrincipal.userId, 'u-viewer');
        assert.deepStrictEqual(principalsAsked, ['u-viewer']);
        assert.strictEqual(seenOpts.needed, 'viewer');
        assert.deepStrictEqual(seenOpts.read.allowColumns, ['name', 'price'],
            'the runner may only ever see the bound columns');
    }));
});

test('a write asks for the editor grade and passes the same allow-list', async (t) => {
    resetClaims();
    GRANTS = { tables: [RW_BINDING] };
    let neededSeen = null;
    let insertOpts = null;
    await withPatches([
        [datatableRuntime, 'resolveForPrincipal', async (id, p, opts) => { neededSeen = opts.needed; return { table: { id }, principal: p }; }],
        [datatableRuntime, 'insertRow', async (_r, opts) => { insertOpts = opts; return { id: 'r-new' }; }],
    ], () => withServer(t, async (base) => {
        const res = await post(base, '/wp1/tables/tbl_1/insert', { values: { name: 'a' } });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { ok: true, id: 'r-new' });
        assert.strictEqual(neededSeen, 'editor');
        assert.deepStrictEqual(insertOpts.allowColumns, ['name', 'price']);
    }));
});

test('update passes rowId/values/expectedUpdatedAt through and answers the projected row', async (t) => {
    resetClaims();
    GRANTS = { tables: [RW_BINDING] };
    let seen = null;
    await withPatches([
        [datatableRuntime, 'resolveForPrincipal', async (id, p) => ({ table: { id }, principal: p })],
        [datatableRuntime, 'updateRow', async (_r, opts) => { seen = opts; return { row: { id: 'r1', name: 'b', updated_at: 't3' } }; }],
    ], () => withServer(t, async (base) => {
        const res = await post(base, '/wp1/tables/tbl_1/update', {
            rowId: 'r1', values: { name: 'b' }, expectedUpdatedAt: 't2',
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).row.name, 'b');
        assert.strictEqual(seen.rowId, 'r1');
        assert.strictEqual(seen.expectedUpdatedAt, 't2');
    }));
});

// ── weigeringen van de runner komen letterlijk terug ─────────────────

test('a runner refusal keeps its status and code; an unexpected throw becomes a bare 500', async (t) => {
    resetClaims();
    GRANTS = { tables: [READ_BINDING] };
    const refusal = new datatableRuntime.DatatableRuntimeError(403, 'datatable_forbidden', 'This needs viewer access to the datatable');
    await withPatches([[datatableRuntime, 'resolveForPrincipal', async () => { throw refusal; }]],
        () => withServer(t, async (base) => {
            const res = await post(base, '/wp1/tables/tbl_1/query');
            assert.strictEqual(res.status, 403);
            const body = await res.json();
            assert.strictEqual(body.code, 'datatable_forbidden');
            assert.match(body.error, /viewer access/);
        }));

    await withPatches([[datatableRuntime, 'resolveForPrincipal', async () => { throw new Error('pg: connection refused to 10.0.0.5'); }]],
        () => withServer(t, async (base) => {
            const res = await post(base, '/wp1/tables/tbl_1/query');
            assert.strictEqual(res.status, 500);
            const body = await res.json();
            assert.strictEqual(body.error, 'Could not read the table');
            assert.strictEqual(/10\.0\.0\.5/.test(JSON.stringify(body)), false,
                'an internal message must not ride out on a refusal');
        }));
});

test('a conflict carries the row the runner already projected', async (t) => {
    resetClaims();
    GRANTS = { tables: [RW_BINDING] };
    const conflict = new datatableRuntime.DatatableRuntimeError(409, 'row_conflict', 'Someone else changed this row while you had it open');
    conflict.row = { id: 'r1', name: 'theirs', updated_at: 't9' };
    await withPatches([
        [datatableRuntime, 'resolveForPrincipal', async (id, p) => ({ table: { id }, principal: p })],
        [datatableRuntime, 'updateRow', async () => { throw conflict; }],
    ], () => withServer(t, async (base) => {
        const res = await post(base, '/wp1/tables/tbl_1/update', { rowId: 'r1', values: { name: 'b' }, expectedUpdatedAt: 't2' });
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.code, 'row_conflict');
        assert.strictEqual(body.row.name, 'theirs');
    }));
});
