/**
 * routes/webpagesGrants — owner-only REST surface for bridge grants.
 *
 * No DB: auth is stubbed with a fixed session, webpageStore.getWebpage and the
 * webpageGrants module functions are monkey-patched, and the router is mounted
 * on a throwaway express app on 127.0.0.1:0 (same pattern as
 * routes/webpagesFullTierProxy.test.js).
 *
 * Run: node --test routes/webpagesGrants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

// Stub auth BEFORE the router module loads (it destructures requireAuth at
// require time).
const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();

const webpageStore = require('../stores/webpageStore');
const webpageGrants = require('../integrations/webpageGrants');
const webpageBindings = require('../core/webpages/webpageBindings');
const grantsRouter = require('./webpagesGrants');

const OWNER = { id: 'u1' };

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

async function withServer(t, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...OWNER } }; next(); });
    app.use(grantsRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    return fn(base);
}

test('GET /:id/grants returns the enriched grant model for the owner', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageGrants, 'describeGrants', async () => ({
            ai: { enabled: true },
            integrations: [{ tool: 'gmail_search', integrationId: 'gmail', available: true, hasFixedArgs: false, label: null, integrationLabel: 'Gmail' }],
            automations: [],
            discoveryFailed: false,
        })],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.integrations[0].tool, 'gmail_search');
        assert.strictEqual(body.discoveryFailed, false);
    }));
});

test('GET /:id/grants 404s for a non-owner', async () => {
    let described = false;
    await withPatches([
        [webpageStore, 'getWebpage', async () => null], // owner-scoped lookup misses
        [webpageGrants, 'describeGrants', async () => { described = true; return {}; }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(described, false, 'grants must never be described for a non-owner');
    }));
});

test('POST /:id/grants/integrations grants a connected tool', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageGrants, 'grantIntegration', async ({ tool, fixedArgs }) => ({
            success: true, tool, integrationId: 'gmail', grants: { integrations: [{ tool, fixedArgs }] },
        })],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants/integrations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'gmail_search', fixedArgs: { q: 'in:inbox' } }),
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.integrationId, 'gmail');
    }));
});

test('POST /:id/grants/integrations maps connection_required to 409 + provider', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageGrants, 'grantIntegration', async () => {
            throw webpageGrants.grantError(409, 'Connect YouTrack first (Settings → Integrations).', 'connection_required', 'youtrack');
        }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants/integrations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: 'youtrack_get_issue' }),
        });
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.code, 'connection_required');
        assert.strictEqual(body.provider, 'youtrack');
    }));
});

test('DELETE /:id/grants/automations/:automationId revokes', async () => {
    let removedId = null;
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageGrants, 'revokeAutomation', async ({ automationId }) => {
            removedId = automationId;
            return { success: true, removed: automationId, grants: { automations: [] } };
        }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants/automations/auto-1`, { method: 'DELETE' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(removedId, 'auto-1');
    }));
});

test('unexpected errors become a generic 500 (no internals leaked)', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageGrants, 'describeGrants', async () => { throw new Error('db down: password=X'); }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/grants`);
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(body.error, 'Failed to load grants');
    }));
});

// ── GET /:id/bindings — wat de pagina zelf doet ───────────────────────

const ACTIONS = {
    code: {
        scanned: true,
        calls: [{ kind: 'fetch', method: null, url: 'https://api.vendor.com/x', host: 'api.vendor.com', source: 'script.js', line: 4, occurrences: 1 }],
        externalCount: 1, unresolved: 0, internal: 2,
    },
    elements: { scanned: true, marks: [], counts: { total: 0, known: 0, unknown: 0 }, unknownTags: [], truncated: 0 },
    uses: { scanned: true, targets: { datatable: [], automation: [], agent: [] }, unresolved: [] },
    forms: { supported: true, scanned: true },
    agent: { known: true, agentId: null, supported: true, internalOnly: true, scanned: true },
};

test('GET /:id/bindings hands the owner the scan of their own code', async () => {
    let askedFor = null;
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageBindings, 'describePageActions', async (args) => { askedFor = args; return ACTIONS; }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/bindings`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.code.scanned, true);
        assert.strictEqual(body.code.calls[0].host, 'api.vendor.com');
        assert.strictEqual(body.agent.internalOnly, true);
        // De scan draait als de EIGENAAR, want alleen die mag de code lezen.
        assert.deepStrictEqual(askedFor, { webpageId: 'wp1', userId: OWNER.id });
    }));
});

test('GET /:id/bindings 404s for a non-owner and never reads the code', async () => {
    let scanned = false;
    await withPatches([
        [webpageStore, 'getWebpage', async () => null],
        [webpageBindings, 'describePageActions', async () => { scanned = true; return ACTIONS; }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/bindings`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(scanned, false, 'someone else\'s script.js must never be scanned');
    }));
});

test('GET /:id/bindings turns an unexpected failure into a generic 500', async () => {
    await withPatches([
        [webpageStore, 'getWebpage', async () => ({ id: 'wp1', userId: OWNER.id })],
        [webpageBindings, 'describePageActions', async () => { throw new Error('rustfs down at 10.0.0.9'); }],
    ], () => withServer(test, async (base) => {
        const res = await fetch(`${base}/wp1/bindings`);
        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.strictEqual(body.error, 'Failed to read what this page does');
        assert.strictEqual(/10\.0\.0\.9/.test(JSON.stringify(body)), false);
    }));
});
