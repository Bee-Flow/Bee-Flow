/**
 * What the GitHub-sync configure route accepts, and what it says when it
 * refuses (routes/integrations/githubSync.js).
 *
 * This body decides where every agent and skill in the org gets pushed.
 * `branch || 'main'` meant a misspelled key — `{ brach: 'staging' }` — was
 * stored as 'main', so the next push wrote the org's configs onto the default
 * branch under `{ success: true }`; and `autoSync === true` meant the string
 * 'true' stored autoSync OFF under the same `{ success: true }`, after which
 * the org quietly never synced again. Nothing on the panel distinguishes
 * either from having been asked for.
 *
 * Run: cd server && node --test routes/integrations/githubSync.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

// The repo-accessibility probe is a bare fetch() in the route.
const originalFetch = global.fetch;
global.fetch = async (url) => { touched.push({ what: 'fetch', args: [String(url)] }); return { ok: true }; };
test.after(() => { global.fetch = originalFetch; });

const MOCKS = {
    '../../auth': { requirePermission: () => pass, resolveUserOrgIds: async () => new Set(['orgA']) },
    '../../stores/githubSyncStore': {
        getOrgSyncConfig: async () => null,
        getSyncOverview: async () => null,
        setOrgSyncConfig: async (orgId, cfg) => { touched.push({ what: 'setOrgSyncConfig', args: [orgId, cfg] }); },
        deleteOrgSyncConfig: async () => {},
        getAllSyncStates: async () => [],
    },
    '../../services/githubSyncService': {
        getToken: async () => 'ghp_test',
        syncAll: async () => [],
        syncPending: async () => [],
    },
    '../../stores/configStore': { getSecret: async () => 'ghp_test' },
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'u1' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-githubsync-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]githubSync\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./githubSync');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' }, isAuthenticated: true }, get() { return undefined; },
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

const REPO = { repoOwner: 'bee-flow', repoName: 'agent-configs' };

test.beforeEach(() => { touched.length = 0; });

test('a misspelled branch key is refused, not stored as main', async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: { ...REPO, brach: 'staging' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/brach/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was configured and nothing was probed');
});

test("autoSync: 'true' is refused, instead of storing the toggle OFF", async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: { ...REPO, autoSync: 'true' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'autoSync is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.autoSync'));
    assert.deepStrictEqual(touched, []);
});

test('a repo owner that is not a GitHub name cannot reach the API URL', async () => {
    for (const repoOwner of ['bee-flow/x', '../../orgs', 'a b']) {
        const res = await dispatch({ method: 'POST', url: '/configure', body: { ...REPO, repoOwner } });
        assert.strictEqual(res.statusCode, 400, `refused: ${repoOwner}`);
        assert.strictEqual(res.body.error, 'repoOwner is the GitHub user or organisation, e.g. bee-flow.');
    }
    assert.deepStrictEqual(touched, []);
});

test('a branch name git itself would refuse is refused here', async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: { ...REPO, branch: 'feat ure' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'branch must be a valid git branch name.');
    assert.deepStrictEqual(touched, []);
});

test('a missing repo is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: { repoOwner: 'bee-flow' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'repoName is the repository name, e.g. agent-configs.');
    assert.deepStrictEqual(touched, []);
});

test('the panel body still configures the org, branch and toggle intact', async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: { ...REPO, branch: 'release/2026', autoSync: true } });
    assert.strictEqual(res.statusCode, 200);
    const cfg = touched.find((t) => t.what === 'setOrgSyncConfig').args[1];
    assert.strictEqual(cfg.branch, 'release/2026');
    assert.strictEqual(cfg.autoSync, true);
});

test('a configure without a branch still defaults to main, and autoSync stays off', async () => {
    const res = await dispatch({ method: 'POST', url: '/configure', body: REPO });
    assert.strictEqual(res.statusCode, 200);
    const cfg = touched.find((t) => t.what === 'setOrgSyncConfig').args[1];
    assert.strictEqual(cfg.branch, 'main');
    assert.strictEqual(cfg.autoSync, false);
});

test('the routes that take no input are unaffected', async () => {
    const res = await dispatch({ method: 'POST', url: '/push' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, results: [] });
});
