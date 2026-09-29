/**
 * What the ISMS-document routes accept, and what they say when they refuse
 * (routes/compliance/isoDocs.js).
 *
 * The policy drawer sends four keys and nothing else, so anything outside
 * them used to be dropped on the way through: `owner_id` for
 * `owner_user_id` answered 200 with the document unchanged. Worse,
 * ismsDocStore.setMeta merged with COALESCE, so it could not tell an absent
 * key from an explicit `null` — and `owner_user_id: null` is exactly how the
 * drawer unassigns an owner. Clearing it did nothing, under a 200, and
 * clause 5 of the conformity statement kept reading the policy as owned.
 *
 *   - the 400 NAMES the field (`body.owner_user_id`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing;
 *   - and the patch PolicyDrawer really sends still saves, and still clears.
 *
 * Run: cd server && node --test routes/compliance/isoDocs.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/complianceStore': {
        addEvidence: async (row) => { touched.push({ what: 'addEvidence', args: [row] }); return { id: 'ev' }; },
    },
    '../../stores/ismsDocStore': {
        listDocs: async () => [],
        listPublishedForUser: async () => [],
        getPublishedBody: async () => ({ body: 'x', version: 1 }),
        getDoc: async (orgId, slug) => ({ organization_id: orgId, slug, status: 'published', current_version: 3, title: 'Policy' }),
        acknowledge: async (...a) => { touched.push({ what: 'acknowledge', args: a }); },
        seedMissing: async (...a) => { touched.push({ what: 'seedMissing', args: a }); return 2; },
        saveDraft: async (orgId, slug, patch, actorId, opts) => {
            touched.push({ what: 'saveDraft', args: [orgId, slug, patch, actorId, opts] });
            return { slug, title: patch.title ?? 'Policy' };
        },
        setMeta: async (orgId, slug, patch) => {
            touched.push({ what: 'setMeta', args: [orgId, slug, patch] });
            return { slug, ...patch };
        },
        publish: async (orgId, slug) => { touched.push({ what: 'publish', args: [orgId, slug] }); return { slug, current_version: 4, published_hash: 'h' }; },
    },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': { resolveOrgId: async () => 'orgA' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:iso-docs-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/]isoDocs\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./isoDocs');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            ip: '10.0.0.1', session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ PUT /iso/docs/:slug ════════════════════════════════════════════

test('a misspelled owner key is refused rather than dropped under a 200', async () => {
    await refuses({ method: 'PUT', url: '/iso/docs/information-security-policy', body: { owner_id: 'u9' } }, 'body');
});

test('clearing the owner reaches setMeta as a real null, so the column can be emptied', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/docs/information-security-policy',
        body: { title: 'Information Security Policy', body: 'text', owner_user_id: null, review_due_at: null },
    });
    assert.strictEqual(res.statusCode, 200);
    const meta = touched.find((t) => t.what === 'setMeta');
    assert.strictEqual(meta.args[2].owner_user_id, null);
    assert.strictEqual(meta.args[2].review_due_at, null);
});

test('the drawer patch still saves the draft with its title and body', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/docs/risk-management',
        body: { title: '  Risk management  ', body: 'How we assess risk', owner_user_id: 'u7', review_due_at: '2027-01-31' },
    });
    assert.strictEqual(res.statusCode, 200);
    const draft = touched.find((t) => t.what === 'saveDraft');
    assert.strictEqual(draft.args[2].title, 'Risk management', 'the schema trims once, on the way in');
    assert.strictEqual(draft.args[2].body, 'How we assess risk');
    assert.strictEqual(touched.find((t) => t.what === 'setMeta').args[2].owner_user_id, 'u7');
});

test('a title that is only spaces is refused in words, not saved as an empty title', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/docs/x', body: { title: '   ' } }, 'body.title');
    assert.strictEqual(res.body.error, 'A policy needs a title.');
});

test('a numeric title is refused by name, instead of being stringified into the document', async () => {
    await refuses({ method: 'PUT', url: '/iso/docs/x', body: { title: 42 } }, 'body.title');
});

test('an unreadable review date is refused rather than reaching the column', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/docs/x', body: { review_due_at: 'next quarter' } }, 'body.review_due_at');
    assert.strictEqual(res.body.error, 'review_due_at must be a date.');
});

// ═══ The three buttons that post an empty body ══════════════════════

test('the seed button posts an empty body and still seeds', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/docs/seed', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'seedMissing'));
});

test('a key on the seed route is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/iso/docs/seed', body: { slugs: ['x'] } }, 'body');
});

test('acknowledging a published policy still records the version it was read at', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/docs/information-security-policy/acknowledge', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.version, 3);
    assert.strictEqual(touched.find((t) => t.what === 'acknowledge').args[2], 3);
});

test('an acknowledgement may not name its own version', async () => {
    await refuses({ method: 'POST', url: '/iso/docs/x/acknowledge', body: { version: 1 } }, 'body');
});

test('publishing still freezes a version and writes the evidence row', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/docs/risk-management/publish', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'publish'));
    assert.strictEqual(touched.find((t) => t.what === 'addEvidence').args[0].payload.action, 'policy_published');
});

test('a publish may not carry a version of its own choosing', async () => {
    await refuses({ method: 'POST', url: '/iso/docs/x/publish', body: { version: 99 } }, 'body');
});
