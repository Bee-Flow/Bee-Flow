/**
 * What the Statement-of-Applicability routes accept, and what they say when
 * they refuse (routes/compliance/isoSoa.js).
 *
 * soaStore keeps what is already on a row whenever it does not recognise a
 * value, so `status: 'aproved'` saved the row as 'todo' and skipped this
 * route's evidence write — an approval an auditor samples, that never
 * happened, answered 200 with the saved row. `applicable: 'false'` is not a
 * boolean, so the control stayed applicable while the screen said excluded.
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.status`), not just "invalid request";
 *   - the message is a sentence that lists the values;
 *   - the store and the evidence chain are never reached;
 *   - and the body SoaPage really sends still saves and still approves.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/isoSoa.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and evidence call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/complianceStore': {
        listEvidence: async () => [], getLatestPerCheck: async () => [], getScoreHistory: async () => [],
    },
    '../../stores/soaStore': {
        listEntries: async () => [],
        getStats: async () => ({ approved: 0, total: 93 }),
        seedMissing: async (...a) => { touched.push({ what: 'seedMissing', args: a }); return 0; },
        upsertEntry: async (orgId, ref, patch, actorId) => {
            touched.push({ what: 'upsertEntry', args: [orgId, ref, patch, actorId] });
            return { control_ref: ref, ...patch };
        },
    },
    '../../stores/ismsDocStore': { listDocs: async () => [] },
    '../../compliance/iso/controls': {
        CONTROLS: [{ ref: 'A.5.1', key: 'policies', theme: 'organizational', bucket: 'attest', titleKey: 't', objectiveKey: 'o' }],
        THEMES: [],
        byRef: (ref) => (ref === 'A.5.1' ? { ref } : null),
    },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': {
        resolveOrgId: async () => 'orgA',
        _isoChecksByControl: () => ({}),
        _recordSoaEvidence: async (...a) => { touched.push({ what: '_recordSoaEvidence', args: a }); },
        _buildClauseConformity: async () => [],
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:iso-soa-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/]isoSoa\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./isoSoa');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
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

// ═══ PUT /iso/soa/:ref ══════════════════════════════════════════════

test('a misspelled decision is refused instead of saving the row as "todo" with no approval on the trail', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/soa/A.5.1', body: { status: 'aproved' } }, 'body.status');
    assert.strictEqual(res.body.error, 'status is one of: todo, reviewed, approved.');
});

test('"applicable" as the string "false" is refused, not read as still applicable', async () => {
    const res = await refuses({ method: 'PUT', url: '/iso/soa/A.5.1', body: { applicable: 'false' } }, 'body.applicable');
    assert.strictEqual(res.body.error, 'applicable is true or false.');
});

test('a source outside the four is refused rather than falling back to "attest"', async () => {
    await refuses({ method: 'PUT', url: '/iso/soa/A.5.1', body: { source: 'attst' } }, 'body.source');
});

test('a misspelled key is refused rather than dropped from the patch under a 200', async () => {
    await refuses({ method: 'PUT', url: '/iso/soa/A.5.1', body: { justifcation: 'inherited from the IaaS provider' } }, 'body');
});

test('an approval still saves the row and still writes the evidence the auditor samples', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/soa/A.5.1',
        body: { status: 'approved', applicable: true, justification: 'Policy signed', how_met: 'Reviewed annually', owner_user_id: null },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'upsertEntry').args[2].status, 'approved');
    assert.ok(touched.some((t) => t.what === '_recordSoaEvidence'), 'the approval belongs on the chain');
});

test('excluding a control still reaches the store as a real false', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/soa/A.5.1',
        body: { status: 'todo', applicable: false, justification: 'No industrial machinery', how_met: null, owner_user_id: null },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'upsertEntry').args[2].applicable, false);
});

test('an unknown control is still a 404, and the schema does not get in front of it', async () => {
    const res = await dispatch({ method: 'PUT', url: '/iso/soa/A.9.9', body: { status: 'approved' } });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ POST /iso/soa/seed ═════════════════════════════════════════════

test('the seed button posts an empty body and still seeds', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/soa/seed', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'seedMissing'));
});

test('a key the seed route does not read is refused rather than seeding the default provider', async () => {
    await refuses({ method: 'POST', url: '/iso/soa/seed', body: { iaas: 'Scaleway' } }, 'body');
});

// ═══ GET /iso/soa/history ═══════════════════════════════════════════

test('a history limit that is not a number is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/iso/soa/history?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a whole number of rows.');
});

test('a misspelled history filter is refused, not dropped into the default page', async () => {
    const res = await dispatch({ method: 'GET', url: '/iso/soa/history?limti=10' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
});
