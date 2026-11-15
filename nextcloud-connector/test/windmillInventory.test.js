/**
 * The Windmill inventory (`POST /hooks/windmill-inventory`, src/windmillInventory.js).
 *
 * Pins:
 *   - which webhook_listeners rows count as Windmill's (the Flow ExApp and a
 *     standalone Windmill), and that our own rows never do;
 *   - the answer is the allow-list summary: no uri, host, token, headers,
 *     authData, eventFilter or userIdFilter ever leaves the connector;
 *   - the route is signed like /hooks/studio-menus: 401 for a forgery, and a
 *     verified call is always 200.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nextcloud.invalid';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';
process.env.BEEFLOW_TENANT_KEY = 'tenant-key';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-wm-inventory-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const config = require('../src/config');
const rateLimit = require('../src/rateLimit');
const inventory = require('../src/windmillInventory');

const TOKEN = 'wm-token-not-a-real-one';
const ROWS = [
    // Flow ExApp: relative, through AppAPI, appId flow.
    { id: 1, appId: 'flow', event: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', uri: '/api/w/nextcloud/jobs/run/f/u/admin/invoice_intake', eventFilter: { 'event.node.path': { $regex: '^/admin/files/Invoices' } }, userIdFilter: 'admin', authData: { Authorization: 'Bearer x' } },
    { id: 2, appId: 'flow', event: 'OCP\\Files\\Events\\Node\\NodeTouchedEvent', uri: '/api/w/nextcloud/jobs/run/f/u/admin/invoice_intake', eventFilter: [] },
    // Standalone Windmill: absolute, the token in the query string.
    { id: 3, appId: null, event: 'OCA\\Forms\\Events\\FormSubmittedEvent', uri: `https://windmill.example.org/api/w/finance/jobs/run/f/f/forms/new%20hire?token=${TOKEN}&service_name=nextcloud`, eventFilter: {}, headers: { 'X-Custom': 'y' } },
    { id: 4, appId: null, event: 'OCA\\Mail\\Events\\NewMessageReceivedEvent', uri: `https://windmill.example.org/base/api/w/finance/jobs/run/p/f/mail/sort?token=${TOKEN}` },
    // Ours, in both forms.
    { id: 5, appId: 'bee_flow', event: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', uri: '/hooks/nextcloud', headers: { 'X-Beeflow-Hook-Event': 'file.new' } },
    // Another app's row, not Windmill.
    { id: 6, appId: 'other', event: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', uri: 'https://hooks.example.net/files' },
    // A Windmill-looking address that is not a run address.
    { id: 7, appId: null, event: 'OCP\\Files\\Events\\Node\\NodeCreatedEvent', uri: 'https://windmill.example.org/api/w/finance/flows/list' },
];

test('Windmill rows are grouped per flow; ours and other apps\' rows are left out', () => {
    const items = inventory.inventoryItems(ROWS);
    assert.deepEqual(items, [
        {
            generation: 'flow_exapp', workspace: 'nextcloud', path: 'u/admin/invoice_intake', kind: 'flow',
            events: { 'OCP\\Files\\Events\\Node\\NodeCreatedEvent': 'file.new', 'OCP\\Files\\Events\\Node\\NodeTouchedEvent': null },
            hasEventFilter: true,
        },
        {
            generation: 'standalone', workspace: 'finance', path: 'f/forms/new hire', kind: 'flow',
            events: { 'OCA\\Forms\\Events\\FormSubmittedEvent': 'forms.submitted' },
            hasEventFilter: false,
        },
        {
            generation: 'standalone', workspace: 'finance', path: 'f/mail/sort', kind: 'script',
            events: { 'OCA\\Mail\\Events\\NewMessageReceivedEvent': 'mail.new' },
            hasEventFilter: false,
        },
    ]);
});

test('nothing but the allow-list leaves: no token, host, uri, filter or user', () => {
    const text = JSON.stringify(inventory.inventoryItems(ROWS));
    for (const secretish of [TOKEN, 'windmill.example.org', 'token=', 'service_name', 'Bearer', 'X-Custom', '$regex', 'Invoices', '"admin"', 'userIdFilter', 'authData', 'uri']) {
        assert.equal(text.includes(secretish), false, `${secretish} must not be in the answer`);
    }
    for (const item of inventory.inventoryItems(ROWS)) {
        assert.deepEqual(Object.keys(item).sort(), ['events', 'generation', 'hasEventFilter', 'kind', 'path', 'workspace']);
    }
});

test('odd addresses are refused rather than guessed', () => {
    assert.equal(inventory.windmillTarget('/api/w/ws/jobs/run/x/a/b'), null, 'neither f nor p');
    assert.equal(inventory.windmillTarget('/api/w/ws/jobs/run/f/'), null, 'no path');
    assert.equal(inventory.windmillTarget('/api/w/ws/jobs/run/f/a%2Fb'), null, 'an encoded slash');
    assert.equal(inventory.windmillTarget('/api/w/ws/jobs/run/f/a%0Ab'), null, 'a control character');
    assert.equal(inventory.windmillTarget('/api/w/ws/jobs/run/f/%E0%A4%A'), null, 'a broken escape');
    assert.deepEqual(inventory.windmillTarget('/api/w/ws/jobs/run_wait_result/f/u/me/x'), { workspace: 'ws', kind: 'flow', path: 'u/me/x' });
    assert.equal(inventory.classifyRow({ event: 'X', uri: 'not a url' }), null);
    assert.equal(inventory.classifyRow({ event: 'X', uri: '/elsewhere/api/w/ws/jobs/run/f/a' }), null, 'a relative row outside /api/w/');
    assert.deepEqual(inventory.inventoryItems(null), []);
});

// ── The route ────────────────────────────────────────────────────────────

const realFetch = global.fetch;
let server;
let base;

test.before(() => {
    config.ncInstanceId = 'nc-instance-a';
    const app = express();
    inventory.mountInventoryHook(app);
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); global.fetch = realFetch; });
test.beforeEach(() => rateLimit.reset());

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** What the server's signer emits (server/auth/connector/ncSigning.js), empty uid. */
function sign(body, { key = 'tenant-key', ts = Math.floor(Date.now() / 1000) } = {}) {
    const message = `${ts}\nPOST\n${inventory.INVENTORY_HOOK_PATH}\n\n${sha256(body)}`;
    return `${ts}.${crypto.createHmac('sha256', key).update(message).digest('hex')}`;
}

function ask(body, sig) {
    return realFetch(`${base}${inventory.INVENTORY_HOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beeflow-sig': sig, 'x-beeflow-nc-uid': '' },
        body,
    });
}

/** Nextcloud's webhook list, answered with `rows` (or a status). */
function mockNextcloud({ rows = ROWS, status = 200 } = {}) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET', uri: new URL(String(url)).search });
        if (String(url).includes('/apps/webhook_listeners/api/v1/webhooks')) {
            return new Response(JSON.stringify({ ocs: { data: rows } }), { status });
        }
        throw new Error(`unexpected fetch: ${url}`);
    };
    return calls;
}

test('a signed call lists every row at service level and answers the summary', async () => {
    const calls = mockNextcloud();
    const body = JSON.stringify({ reason: 'windmill_import' });
    const res = await ask(body, sign(body));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.items.length, 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].uri, '', 'listed without ?uri=, so Nextcloud answers every row');
});

test('a Nextcloud without webhook_listeners is ok:false, still HTTP 200', async () => {
    mockNextcloud({ status: 404 });
    const body = '{}';
    const res = await ask(body, sign(body));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: 'webhook_listeners_disabled' });
});

test('a forgery is 401 and Nextcloud is never asked; a flood of them is 429', async () => {
    const calls = mockNextcloud();
    const body = '{}';
    assert.equal((await ask(body, sign(body, { key: 'not-the-key' }))).status, 401);
    assert.equal((await ask(body, sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
    assert.equal((await ask('{"x":1}', sign(body))).status, 401);
    assert.equal(calls.length, 0);
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await ask(body, 'garbage')).status;
    assert.equal(last, 429);
});
