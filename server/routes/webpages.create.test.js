/**
 * routes/webpages — the describe-to-build CREATE handler (plan W1).
 *
 * What is pinned here is the contract the overview's build bar depends on:
 *   - `create_webpage` from webpageBuilderTools is the ONE creation path;
 *   - the framework/runtime tier is still written (resolveFramework falls
 *     back to 'vanilla' at read time, so a page whose settings were never
 *     written is NOT the product default);
 *   - a source is verified for the caller BEFORE the page exists, so a
 *     refused source leaves no orphan page behind;
 *   - a picked automation becomes a real grant, and a table does not (the
 *     bridge-grant normalizer has no `tables` slice until W3);
 *   - the name is derived from the brief when the caller sent none.
 *
 * No DB: auth and the org gate are stubbed before the router loads, and every
 * store/tool touch is monkey-patched (same pattern as webpagesGrants.test.js).
 *
 * Run: node --test --test-force-exit routes/webpages.create.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

// Both are destructured at require time by routes/webpages.js.
const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();

const webpageStore = require('../stores/webpageStore');
const builderTools = require('../integrations/webpageBuilderTools');
const webpageGrants = require('../integrations/webpageGrants');
const automationStore = require('../stores/automationStore');
const datatableStore = require('../stores/datatableStore');
const datatableAccess = require('../auth/datatableAccess');

const webpagesRouter = require('./webpages');

const OWNER = { id: 'u1', organizationId: 'org1' };

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
    app.use(webpagesRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

function post(base, body) {
    return fetch(`${base}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** The happy-path stubs every test starts from; `calls` records what ran. */
function baseStubs(calls) {
    return [
        [builderTools, 'executeBuilderTool', async (toolName, args) => {
            calls.created.push({ toolName, args });
            return { result: { webpageId: 'wp1', url: '/app/webpages/wp1', name: args.name || 'Untitled Webpage' } };
        }],
        [webpageStore, 'updateWebpageMetadata', async (id, userId, updates) => {
            calls.meta.push({ id, userId, updates });
            return true;
        }],
        [webpageStore, 'getWebpage', async (id) => ({ id, userId: OWNER.id, name: 'Page', isPublished: false })],
        [webpageGrants, 'grantAutomation', async (a) => { calls.grants.push(a); return { success: true }; }],
    ];
}

function newCalls() {
    return { created: [], meta: [], grants: [] };
}

/* ── the shared creation path ─────────────────────────────────────────── */

test('creates through create_webpage and writes the framework/runtime tier', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { name: 'Status page' });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.webpage.id, 'wp1');

        assert.strictEqual(calls.created.length, 1);
        assert.strictEqual(calls.created[0].toolName, 'create_webpage');
        assert.strictEqual(calls.created[0].args.name, 'Status page');

        const { DEFAULT_NEW_FRAMEWORK, DEFAULT_RUNTIME } = require('../integrations/webpageFramework');
        assert.deepStrictEqual(calls.meta[0].updates.settings, {
            framework: DEFAULT_NEW_FRAMEWORK,
            runtime: DEFAULT_RUNTIME,
        });
        // No brief, no instructions written.
        assert.strictEqual(calls.meta[0].updates.instructions, undefined);
    }));
});

test('an explicit framework/runtime wins over the new-page default', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { name: 'Vanilla', framework: 'vanilla', runtime: 'full' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(calls.meta[0].updates.settings, { framework: 'vanilla', runtime: 'full' });
    }));
});

/* ── the brief ────────────────────────────────────────────────────────── */

test('derives the name from the brief and stores the brief as instructions', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const prompt = 'A status page for customers who enter their quote number and see the progress. Keep it plain.';
        const res = await post(base, { prompt });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.prompt, prompt);

        const derived = calls.created[0].args.name;
        assert.ok(derived.length <= 60, `derived name too long: ${derived}`);
        assert.ok(derived.startsWith('A status page for customers'), derived);
        assert.ok(!derived.includes('Keep it plain'), 'stops at the first sentence');
        assert.strictEqual(calls.meta[0].updates.instructions, prompt);
    }));
});

test('an explicit name and explicit instructions are never overwritten by the brief', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { name: 'Kept', prompt: 'Build a thing', instructions: 'Only these' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.created[0].args.name, 'Kept');
        assert.strictEqual(calls.meta[0].updates.instructions, 'Only these');
    }));
});

/* ── sources ──────────────────────────────────────────────────────────── */

test('an automation source is verified, granted, and named in the brief', async () => {
    const calls = newCalls();
    await withPatches([
        ...baseStubs(calls),
        [automationStore, 'getAutomation', async (id) => ({ id, userId: OWNER.id, title: 'Request from website' })],
    ], () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'Intake form', sources: [{ kind: 'automation', id: 'a1' }] });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(body.sources, [{ kind: 'automation', id: 'a1', name: 'Request from website' }]);

        assert.strictEqual(calls.grants.length, 1);
        assert.strictEqual(calls.grants[0].automationId, 'a1');
        assert.strictEqual(calls.grants[0].webpageId, 'wp1');
        assert.strictEqual(calls.grants[0].userId, OWNER.id);
        assert.match(calls.meta[0].updates.instructions, /Automation "Request from website" \(id a1\)/);
    }));
});

test("someone else's automation is refused BEFORE a page is created", async () => {
    const calls = newCalls();
    await withPatches([
        ...baseStubs(calls),
        [automationStore, 'getAutomation', async (id) => ({ id, userId: 'someone-else', title: 'Theirs' })],
    ], () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'x', sources: [{ kind: 'automation', id: 'a1' }] });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(calls.created.length, 0, 'no orphan page');
        assert.strictEqual(calls.grants.length, 0);
    }));
});

test('a table the caller holds no grade on is a 404, and nothing is created', async () => {
    const calls = newCalls();
    await withPatches([
        ...baseStubs(calls),
        [datatableAccess, 'resolveDatatablePrincipal', async () => ({ userId: OWNER.id, orgId: 'org1' })],
        [datatableAccess, 'datatableScopesFor', () => [{ kind: 'org', id: 'org1' }]],
        [datatableStore, 'getDatatable', async () => null],
    ], () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'x', sources: [{ kind: 'datatable', id: 't1' }] });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(calls.created.length, 0, 'no orphan page');
    }));
});

test('a readable table is named in the brief but never written as a bridge grant', async () => {
    const calls = newCalls();
    await withPatches([
        ...baseStubs(calls),
        [datatableAccess, 'resolveDatatablePrincipal', async () => ({ userId: OWNER.id, orgId: 'org1' })],
        [datatableAccess, 'datatableScopesFor', () => [{ kind: 'org', id: 'org1' }]],
        [datatableStore, 'getDatatable', async (id) => ({ id, name: 'Quotes', organization_id: 'org1' })],
        [datatableStore, 'listGrants', async () => []],
        [datatableAccess, 'gradeForPrincipal', () => 'viewer'],
    ], () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'Status page', sources: [{ kind: 'datatable', id: 't1' }] });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(body.sources, [{ kind: 'datatable', id: 't1', name: 'Quotes' }]);
        assert.match(calls.meta[0].updates.instructions, /Table "Quotes" \(id t1\)/);
        assert.strictEqual(calls.grants.length, 0, 'tables have no bridge-grant slice until W3');
    }));
});

test('an unknown source kind is a 400 and the extra keys never reach the store', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'x', sources: [{ kind: 'secret', id: 's1', mode: 'readwrite' }] });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(calls.created.length, 0);
    }));
});

test('more than ten sources is a 400', async () => {
    const calls = newCalls();
    const many = Array.from({ length: 11 }, (_, i) => ({ kind: 'automation', id: `a${i}` }));
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { prompt: 'x', sources: many });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(calls.created.length, 0);
    }));
});

test('duplicate sources collapse to one grant', async () => {
    const calls = newCalls();
    await withPatches([
        ...baseStubs(calls),
        [automationStore, 'getAutomation', async (id) => ({ id, userId: OWNER.id, title: 'Once' })],
    ], () => withServer(test, async (base) => {
        const res = await post(base, {
            prompt: 'x',
            sources: [{ kind: 'automation', id: 'a1' }, { kind: 'automation', id: 'a1' }],
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.grants.length, 1);
    }));
});

/* ── the name-only shortcut still works exactly as before ─────────────── */

test('name-only create sends no prompt and no sources', async () => {
    const calls = newCalls();
    await withPatches(baseStubs(calls), () => withServer(test, async (base) => {
        const res = await post(base, { name: 'Page C' });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.prompt, '');
        assert.deepStrictEqual(body.sources, []);
        assert.strictEqual(calls.grants.length, 0);
    }));
});
