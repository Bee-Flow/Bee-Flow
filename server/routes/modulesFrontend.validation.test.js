/**
 * What the module frontend manifest answers when it cannot read, and what it
 * accepts (routes/modulesFrontend.js).
 *
 * The SPA's module registry (agent-hub/src/moduleRuntime/registry.js) keeps
 * its last-good set of remote Studio apps on a 5xx and REPLACES it on a 200.
 * The route used to turn a failed module-state read into `200 { modules: [] }`,
 * so one database blip removed every remote Studio app tab from the screen.
 * What this file pins:
 *
 *   - a failed read reaches the terminal handler as a 500, never as a list;
 *   - the manifest the SPA reads keeps its shape;
 *   - the route takes no query, and a refused one reads nothing.
 *
 * Run: cd server && node --test routes/modulesFrontend.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
let storeFails = false;

const ROWS = [
    { moduleId: 'uptime_monitor', remote: true, entry: {
        id: 'uptime_monitor', version: '1.2.0', name: 'Uptime', icon: 'box', capabilityIds: ['uptime'],
        frontend: { entry: 'entry.js', css: ['/style.css'], studioApp: { labels: { en: 'Uptime', nl: 'Beschikbaarheid' } } },
    } },
    // Built-in (not remote): never listed.
    { moduleId: 'apps', remote: false, entry: null },
];

const MOCKS = {
    '../auth/permissions': { requireAuth: pass },
    '../modules': { isModuleActive: async (id) => id === 'uptime_monitor' },
    '../modules/remoteCatalog': {
        isRemoteRow: (row) => row.remote === true,
        entryFromRow: (row) => row.entry,
    },
    '../stores/platformModuleStore': {
        getAllStates: async () => {
            touched.push({ what: 'getAllStates' });
            if (storeFails) throw new Error('connection terminated unexpectedly');
            return ROWS;
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:modules-frontend-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]modulesFrontend\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./modulesFrontend');
test.after(() => { Module._resolveFilename = originalResolve; });

// A refusal or a thrown error travels to the terminal handler, so the harness
// has to answer one the way index.js does.
const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const terminalErrorHandler = createTerminalErrorHandler({ log: { warn() {}, error() {} } });

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; storeFails = false; });

test('a failed module-state read is a 500, not "nothing is installed"', async () => {
    storeFails = true;
    const res = await dispatch({ method: 'GET', url: '/frontend' });
    assert.strictEqual(res.statusCode, 500,
        'the SPA keeps its last-good modules on a 5xx and replaces them on a 200');
    assert.strictEqual(res.body.modules, undefined, 'no empty list rides along with the failure');
    assert.ok(res.body.correlationId, 'the failure is traceable in the log');
});

test('the manifest the SPA reads still lists the active remote module', async () => {
    const res = await dispatch({ method: 'GET', url: '/frontend' });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.rev, /^[0-9a-f]{16}$/);
    assert.deepStrictEqual(res.body.modules, [{
        id: 'uptime_monitor',
        version: '1.2.0',
        studioApp: {
            urlSegment: 'uptime_monitor',
            labels: { en: 'Uptime', nl: 'Beschikbaarheid' },
            icon: 'boxes',
            gateCapability: 'uptime',
        },
        entryUrl: '/api/module-assets/uptime_monitor/1.2.0/frontend/entry.js',
        cssUrls: ['/api/module-assets/uptime_monitor/1.2.0/frontend/style.css'],
    }]);
});

test('a query key is refused in words, and nothing is read', async () => {
    const res = await dispatch({ method: 'GET', url: '/frontend?includeInactive=1' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.strictEqual(res.body.error, 'The module manifest takes no parameters.');
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, []);
});
