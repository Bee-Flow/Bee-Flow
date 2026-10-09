/**
 * What GET /builder/session/:automationId accepts (routes/ai/automationBuilder/
 * sessionSnapshot.js): nothing from the query. There is one snapshot per
 * automation and it comes back whole, so a `?version=` that looks like it asks
 * for an older one is refused by name rather than answered with the latest.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/sessionSnapshot.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every read lands in `touched`. A refused request must leave it empty.
const touched = [];
const written = [];
const pass = (req, res, next) => next();
// requireActiveOrgForMutations() is called once per route that carries it.
let activeOrgGates = 0;

const MOCKS = {
    '../../../stores/automationStore': {
        getBuilderSession: async (automationId, userId) => {
            touched.push({ automationId, userId });
            if (automationId === 'a2') return { sessionId: 's2', version: 5, proposal: { id: 'prop1' }, reviewPlan: { id: 'plan1' } };
            if (automationId === 'a3') return { sessionId: 's3', version: 7, approvedDatatableIds: ['tbl_old'], reviewQuestions: [{ id: 'q', prompt: 'P', options: ['A', 'B'], choice: { kind: 'datatable' } }], proposal: { id: 'prop3', applying: { token: 'secret', at: 't' }, pendingDatatables: [{ ref: 'pending:1', name: 'Facturen', createdId: 'tbl_made' }, { ref: 'pending:2', name: 'Klanten' }] } };
            return automationId === 'a1' ? { sessionId: 's1', version: 2 } : null;
        },
        setBuilderSession: async (automationId, userId, snapshot, opts) => {
            written.push({ automationId, snapshot, opts });
            return { ok: true };
        },
    },
    '../../../auth/permissions': { requireAuth: pass, requireActiveOrgForMutations: () => { activeOrgGates += 1; return pass; } },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:automation-builder-snapshot-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]sessionSnapshot\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./sessionSnapshot');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(search));
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
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

test.beforeEach(() => { touched.length = 0; written.length = 0; });

test('the review route is gated by requireActiveOrgForMutations (a suspended organisation cannot create tables)', () => {
    assert.strictEqual(activeOrgGates, 1);
});

test('a version the route cannot serve is refused by name, not answered with the latest', async () => {
    const res = await dispatch({ method: 'GET', url: '/session/a1?version=1' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /version/);
    assert.deepStrictEqual(touched, []);
});

test('the plain request the builder sends on mount still rehydrates, scoped to the caller', async () => {
    const res = await dispatch({ method: 'GET', url: '/session/a1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { snapshot: { sessionId: 's1', version: 2 } });
    assert.deepStrictEqual(touched, [{ automationId: 'a1', userId: 'u1' }]);
});

// BFSF-486: Apply and Discard used to send the same action, so nothing could
// tell the agent whether its staged changes went live.
test('Apply and Discard each clear the proposal and record a distinct outcome for the agent', async () => {
    for (const [action, status] of [['applyProposal', 'applied'], ['discardProposal', 'discarded']]) {
        written.length = 0;
        const res = await dispatch({ method: 'POST', url: '/session/a2/review', body: { action, revisionId: 'prop1' } });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.outcome, status);
        const { snapshot, opts } = written[0];
        assert.strictEqual(snapshot.proposal, null);
        assert.deepStrictEqual(snapshot.reviewPlan, { id: 'plan1' });
        assert.strictEqual(snapshot.reviewOutcome.kind, 'proposal');
        assert.strictEqual(snapshot.reviewOutcome.status, status);
        assert.strictEqual(snapshot.reviewOutcome.id, 'prop1');
        assert.strictEqual(opts.expectedVersion, 5);
    }
});

test('a review of a revision that is no longer saved is refused and writes nothing', async () => {
    const res = await dispatch({ method: 'POST', url: '/session/a2/review', body: { action: 'applyProposal', revisionId: 'old' } });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(written, []);
});

test('a proposal without tables behaves as before: the response adds definition null and no created tables', async () => {
    const res = await dispatch({ method: 'POST', url: '/session/a2/review', body: { action: 'applyProposal', revisionId: 'prop1' } });
    assert.deepStrictEqual(res.body, { ok: true, outcome: 'applied', definition: null, createdDatatables: [] });
});

test('Discard never creates a table; it reports the ones an earlier failed Apply made, remembers them as chosen and does not delete them', async () => {
    const res = await dispatch({ method: 'POST', url: '/session/a3/review', body: { action: 'discardProposal', revisionId: 'prop3' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.keptDatatables, [{ id: 'tbl_made', name: 'Facturen' }]);
    const { snapshot } = written[0];
    assert.strictEqual(snapshot.proposal, null);
    assert.deepStrictEqual(snapshot.approvedDatatableIds, ['tbl_old', 'tbl_made']);
    const plain = await dispatch({ method: 'POST', url: '/session/a2/review', body: { action: 'discardProposal', revisionId: 'prop1' } });
    assert.deepStrictEqual(plain.body.keptDatatables, []);
});

test('the snapshot the client reads has neither the question `choice` nor the Apply claim', async () => {
    const res = await dispatch({ method: 'GET', url: '/session/a3' });
    assert.ok(!('choice' in res.body.snapshot.reviewQuestions[0]));
    assert.ok(!('applying' in res.body.snapshot.proposal));
    assert.strictEqual(res.body.snapshot.proposal.pendingDatatables.length, 2);
});
