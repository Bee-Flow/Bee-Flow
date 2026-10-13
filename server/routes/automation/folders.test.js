/**
 * The folder routes, as the caller experiences them.
 *
 * Both handlers used to hand `req.body?.name` straight to the store and, when
 * anything went wrong, answer `400 { error: e.message }`. A blank name reached
 * the INSERT and came back as the store's sentence; a driver error came back as
 * the driver's. So the schema is the contract now: it says what a folder needs
 * before a row is attempted, and the only message that survives a failure is
 * one written here.
 *
 * The routes are exercised through a real Express app with the terminal error
 * handler mounted, because the interesting part IS the handler: `validate`
 * raises an HttpError and the shape of the 400 is decided there.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..', '..');

/** Replace a module in the require cache before crud.js pulls it in. */
function stub(id, exports) {
    const resolved = require.resolve(path.join(SERVER, id));
    const m = new Module(resolved);
    m.exports = exports;
    m.loaded = true;
    require.cache[resolved] = m;
}

const calls = { create: [], update: [] };
let createImpl = async (input) => ({ id: 'f1', ...input });
let updateImpl = async (id, patch) => ({ id, ...patch });
let existing = { id: 'f1', name: 'Old' };

stub('stores/automationStore', {
    createFolder: async (input) => { calls.create.push(input); return createImpl(input); },
    updateFolder: async (id, patch) => { calls.update.push({ id, patch }); return updateImpl(id, patch); },
    getFolder: async () => existing,
    listFolders: async () => [],
    getAutomation: async () => null,
    getAutomationsForUser: async () => [],
});
stub('auth/datatableAccess', {
    resolveDatatablePrincipal: async () => ({ orgId: 'org-1' }),
    requireDatatableGrade: () => (req, res, next) => next(),
});

const router = require('./crud');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'u1' }, isAuthenticated: true }; next(); });
    app.use('/api/automation', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

test.beforeEach(() => {
    calls.create.length = 0;
    calls.update.length = 0;
    createImpl = async (input) => ({ id: 'f1', ...input });
    updateImpl = async (id, patch) => ({ id, ...patch });
    existing = { id: 'f1', name: 'Old' };
});

const send = async (method, p, body) => {
    const res = await fetch(`${baseUrl}/api/automation${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};

describe('what the schema refuses before the store is asked', () => {
    test('a missing or blank name is a 400 that names the field', async () => {
        for (const body of [{}, { name: '' }, { name: '   ' }]) {
            const { status, body: out } = await send('POST', '/folders', body);
            assert.equal(status, 400, `body ${JSON.stringify(body)}`);
            assert.equal(out.code, 'invalid_request');
            assert.match(out.error, /name/i);
            assert.equal(out.details[0].path, 'body.name');
        }
        assert.equal(calls.create.length, 0, 'the store is never asked');
    });

    test('a name past the store limit is refused here, not truncated there', async () => {
        const { status, body } = await send('POST', '/folders', { name: 'x'.repeat(81) });
        assert.equal(status, 400);
        assert.equal(body.details[0].path, 'body.name');
        assert.equal(calls.create.length, 0);
    });

    test('an unknown field is refused rather than silently dropped', async () => {
        const { status, body } = await send('POST', '/folders', { name: 'Ok', organizationId: 'org-someone-else' });
        assert.equal(status, 400);
        assert.equal(body.code, 'invalid_request');
        assert.equal(calls.create.length, 0);
    });

    test('every 400 carries a correlation id and no stack', async () => {
        const { body } = await send('POST', '/folders', {});
        assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
        assert.ok(!/\bat\s/.test(JSON.stringify(body)), 'no stack frames');
    });
});

describe('what reaches the store', () => {
    test('the name is trimmed and the org comes from the resolver, not the body', async () => {
        const { status, body } = await send('POST', '/folders', { name: '  Invoices  ', icon: '📁' });
        assert.equal(status, 201);
        assert.deepEqual(calls.create[0], { organizationId: 'org-1', name: 'Invoices', icon: '📁' });
        assert.equal(body.folder.name, 'Invoices');
    });

    test('a rename sends only what it changed', async () => {
        const { status } = await send('PUT', '/folders/f1', { name: 'Paid' });
        assert.equal(status, 200);
        assert.deepEqual(calls.update[0], { id: 'f1', patch: { name: 'Paid' } });
    });

    test('an update of a folder that is gone is a 404', async () => {
        existing = null;
        const { status } = await send('PUT', '/folders/f1', { name: 'Paid' });
        assert.equal(status, 404);
        assert.equal(calls.update.length, 0);
    });
});

describe('what a failing store says', () => {
    test('a unique-index violation becomes a 409 written for the caller', async () => {
        createImpl = async () => { throw new Error('duplicate key value violates unique constraint "automation_folders_org_name_idx"'); };
        const { status, body } = await send('POST', '/folders', { name: 'Invoices' });
        assert.equal(status, 409);
        assert.equal(body.code, 'folder_name_taken');
        assert.equal(body.error, 'A folder with that name already exists.');
        assert.ok(!body.error.includes('automation_folders'), 'the index name stays server-side');
    });

    test('any other store failure is a 500 that says nothing about the database', async () => {
        createImpl = async () => { throw new Error('connect ECONNREFUSED 10.42.0.7:5432'); };
        const { status, body } = await send('POST', '/folders', { name: 'Invoices' });
        assert.equal(status, 500);
        assert.equal(body.error, 'Internal server error');
        assert.ok(!JSON.stringify(body).includes('10.42.0.7'));
    });
});
