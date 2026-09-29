/**
 * What POST /agents/:id/publish-version accepts, and how it fails
 * (routes/agents/publishVersion.js).
 *
 * The route publishes the concept as it is NOW, at the rev it reads itself,
 * so the request carries nothing. A body used to be ignored: `{ expectedRev: 3 }`
 * looked like it pinned which content went live and was answered with a 200
 * that published whatever the concept had become. What this file pins:
 *
 *   - a body is refused with a 400 that names the key, and nothing is published;
 *   - the bodiless POST the builder sends still publishes;
 *   - a reference the owner may not use is still refused in the validator's words;
 *   - a store failure during the retry is a 500 with a correlation id, where it
 *     used to be a 400 carrying the driver's own message.
 *
 * Run: cd server && node --test routes/agents/publishVersion.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every publish lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { validate: null, publish: null };

const AGENT = { id: 'a1', owner_id: 'owner', organization_id: 'orgA', rev: 4, is_published: false, config: {} };

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => (id === 'a1' ? { ...AGENT } : null),
        publishAgentVersion: async (id, opts) => { touched.push({ what: 'publishAgentVersion', args: [id, opts] }); return fx.publish(id, opts); },
    },
    '../../auth': { requireActiveOrgForMutations: () => (req, res, next) => next() },
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'owner' },
    './crud': {
        canModifyAgent: async () => true,
        validateAgentConfigReferences: (agent, cfg) => fx.validate(agent, cfg),
        applyConfigValidation: (cfg) => cfg,
    },
    '../../stores/versionStore': { createVersion: async () => {} },
    '../../compliance/events': { EVENTS: { AGENT_PUBLISHED: 'agent_published' }, emit: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-publish-version-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]publishVersion\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./publishVersion');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const quiet = { error() {}, warn() {}, info() {}, debug() {} };
const terminalErrorHandler = createTerminalErrorHandler({ log: quiet });

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'owner' } }, get() { return undefined; },
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

const published = (id, opts) => ({
    ok: true, row: { id, rev: opts.expectedRev }, publishedVersion: 2, publishedRev: opts.expectedRev, publishedAt: 'T',
});

test.beforeEach(() => {
    touched.length = 0;
    fx.validate = async () => ({ warnings: [] });
    fx.publish = published;
});

test('a body that looks like it pins the rev is refused by name, and nothing is published', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/publish-version', body: { expectedRev: 3 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /expectedRev/);
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, []);
});

test('the bodiless POST the builder sends still publishes', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/publish-version', body: undefined });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.publishedVersion, 2);
    assert.strictEqual(touched.length, 1);
});

test('a reference the owner may not use is still refused in the validator\'s own words', async () => {
    fx.validate = async () => { const e = new Error('Agent owner cannot access: knowledge base kb1'); e.status = 400; throw e; };
    const res = await dispatch({ method: 'POST', url: '/a1/publish-version', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Agent owner cannot access: knowledge base kb1');
    assert.deepStrictEqual(touched, []);
});

test('a store failure on the retry is a 500, not a 400 that quotes the driver', async () => {
    let calls = 0;
    fx.publish = () => {
        calls += 1;
        if (calls === 1) return { conflict: true, currentRev: 5 };
        throw new Error('deadlock detected on relation "agents"');
    };
    const res = await dispatch({ method: 'POST', url: '/a1/publish-version', body: {} });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the operator can find it in the log');
    assert.doesNotMatch(JSON.stringify(res.body), /deadlock/);
});

test('an unexpected failure while validating is a 500 as well', async () => {
    fx.validate = async () => { throw new TypeError("Cannot read properties of undefined (reading 'org_id')"); };
    const res = await dispatch({ method: 'POST', url: '/a1/publish-version', body: {} });
    assert.strictEqual(res.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /org_id/);
    assert.deepStrictEqual(touched, []);
});
