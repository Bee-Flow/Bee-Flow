'use strict';

/**
 * The server half of the Windmill inventory (sources/ncInventory.mts): a
 * signed, service-level POST to the org's connector, the outcome of every
 * answer, and the connector's items checked again before they are used.
 *
 * Run: cd server && node --test automation/importers/windmill/sources/ncInventory.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { fetchWindmillInventory, checkItem, INVENTORY_HOOK_PATH } = require('./ncInventory.mts');
const { signedConnectorHeaders } = require('../../../../auth/connector/ncSigning');

const TARGET = { callbackUrl: 'https://cloud.example/index.php/apps/app_api/proxy/bee_flow', tenantKey: 'tenant-key' };

/**
 * @param {{ status?: number, body?: unknown, throws?: Error, target?: unknown }} [answer]
 */
function deps(answer = {}) {
    /** @type {{ url: string, init: Record<string, any> }[]} */
    const calls = [];
    return {
        calls,
        deps: {
            resolveTarget: async () => (answer.target === undefined ? TARGET : answer.target),
            fetch: async (/** @type {string} */ url, /** @type {Record<string, any>} */ init) => {
                calls.push({ url, init });
                if (answer.throws) throw answer.throws;
                const status = answer.status ?? 200;
                return { ok: status < 300, status, json: async () => answer.body };
            },
            sign: signedConnectorHeaders,
        },
    };
}

const ITEM = { generation: 'standalone', workspace: 'finance', path: 'f/forms/new_hire', kind: 'flow', events: { 'OCA\\Forms\\Events\\FormSubmittedEvent': 'forms.submitted' }, hasEventFilter: true };

test('a signed service-level POST to the hook, with no Nextcloud user', async () => {
    const d = deps({ body: { ok: true, items: [ITEM] } });
    const out = await fetchWindmillInventory('org-1', d.deps);
    assert.deepStrictEqual(out, { outcome: 'ok', items: [ITEM] });
    assert.strictEqual(d.calls.length, 1);
    const { url, init } = d.calls[0];
    assert.strictEqual(url, `${TARGET.callbackUrl}${INVENTORY_HOOK_PATH}`);
    assert.strictEqual(init.method, 'POST');
    assert.strictEqual(init.headers['X-Beeflow-NC-Uid'], '');
    assert.match(init.headers['X-Beeflow-Sig'], /^\d+\.[0-9a-f]{64}$/);
    const ts = Number(init.headers['X-Beeflow-Sig'].split('.')[0]);
    const again = signedConnectorHeaders({ tenantKey: 'tenant-key', method: 'POST', path: INVENTORY_HOOK_PATH, ncUid: '', body: init.body, ts });
    assert.strictEqual(init.headers['X-Beeflow-Sig'], again['X-Beeflow-Sig'], 'signed over exactly the body sent');
    const body = JSON.parse(init.body);
    assert.deepStrictEqual(Object.keys(body).sort(), ['reason', 'sentAt'], 'no key named like a route parameter of the proxy');
});

test('outcomes: no connector, an old connector, webhook_listeners off, a broken answer', async () => {
    assert.deepStrictEqual(await fetchWindmillInventory('org-1', deps({ target: null }).deps), { outcome: 'not_connected' });
    for (const status of [404, 401, 403, 429]) {
        assert.strictEqual((await fetchWindmillInventory('org-1', deps({ status }).deps)).outcome, 'unsupported', String(status));
    }
    assert.strictEqual((await fetchWindmillInventory('org-1', deps({ status: 502 }).deps)).outcome, 'unreachable');
    assert.deepStrictEqual(await fetchWindmillInventory('org-1', deps({ body: { ok: false, error: 'webhook_listeners_disabled' } }).deps), { outcome: 'no_listeners' });
    assert.strictEqual((await fetchWindmillInventory('org-1', deps({ body: { ok: false, error: 'list_failed' } }).deps)).outcome, 'unreachable');
    assert.strictEqual((await fetchWindmillInventory('org-1', deps({ body: 'html' }).deps)).outcome, 'unreachable');
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    assert.deepStrictEqual(await fetchWindmillInventory('org-1', deps({ throws: timeout }).deps), { outcome: 'unreachable', detail: 'timeout' });
});

test('items are checked again: unknown keys dropped, malformed items left out', () => {
    assert.deepStrictEqual(checkItem({ ...ITEM, uri: 'https://x/?token=y', userIdFilter: 'alice' }), ITEM);
    assert.strictEqual(checkItem({ ...ITEM, generation: 'other' }), null);
    assert.strictEqual(checkItem({ ...ITEM, path: '' }), null);
    assert.strictEqual(checkItem({ ...ITEM, events: null }), null);
    assert.strictEqual(checkItem('x'), null);
    assert.deepStrictEqual(checkItem({ ...ITEM, events: { A: 5, B: 'file.new' } })?.events, { A: null, B: 'file.new' });
});
