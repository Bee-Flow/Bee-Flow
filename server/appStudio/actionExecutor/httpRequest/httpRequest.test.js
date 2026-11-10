/**
 * The http_request step (actionExecutor/steps/http_request.mts) against stubbed fetch, credential
 * and privacy-check dependencies: what it sends, what it refuses before sending, how it answers.
 * The address and SSRF rules have their own file (httpRequest.ssrf.test.js).
 *
 * Run: node --test server/appStudio/actionExecutor/httpRequest/httpRequest.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runHttpRequest } = require('../steps/http_request.mts');
const { executeDataStep } = require('../dispatch');
const { isPrivateTarget } = require('../../../utils/isPrivateTarget');

const APP = { id: 'app_1', userId: 'owner_1', organizationId: 'org_1', name: 'Orders' };
const CONNECTOR = {
    id: 'conn_ab12cd', kind: 'rest', url: 'https://api.example.test/v1/items?since={since}',
    headers: { 'X-Api-Version': '2' }, auth: { credentialProvider: 'acme', type: 'header', header: 'X-Api-Key' },
};
const MODEL = { tables: [], connectors: [CONNECTOR, { id: 'conn_mail01', kind: 'mailbox', provider: 'gmail' }] };

function response(status, body, headers = {}) {
    return { status, headers: new Headers(headers), body: undefined, text: async () => body };
}

/** Dependencies that record what was fetched and what the privacy check saw. */
function harness(over = {}) {
    const calls = [];
    const checked = [];
    const ledger = [];
    const deps = {
        safeFetch: async (url, init) => { calls.push({ url: String(url), init }); return (over.respond || (() => response(200, '{"ok":true}')))(String(url), init, calls.length); },
        isPrivateTarget,
        isPrivateAddressError: () => false,
        getProviderAuth: over.getProviderAuth || (async (userId, provider) => (userId === 'owner_1' && provider === 'acme' ? { accessToken: 'tok-secret' } : null)),
        capture: async (fn) => { try { return { ok: true, value: await fn(), probe: null }; } catch (error) { return { ok: false, error, probe: null }; } },
        env: over.env || {},
        safety: {
            resolveAutomationPolicy: async (ctx, opts) => ({ optOutHonoured: opts.honourAutomationOptOut, orgId: ctx.orgId }),
            buildAuditBase: (ctx, step, opts) => ({ step_id: step.id, source: opts.source, automation_id: ctx.automationId }),
            guardToolInput: over.guard || (async (payload) => { checked.push(payload); return { value: payload, tokenMap: null, categories: [], markers: [] }; }),
            logEgress: async (entry) => { ledger.push(entry); },
        },
    };
    return { deps, calls, checked, ledger };
}

const CTX = { viewerId: 'viewer_1', actionId: 'act_send', formValues: { orderId: 'A 1/2', note: 'Deliver on Friday', qty: 3 }, vars: { region: 'eu' }, item: { id: 7 } };

test('GET: the address is the connector origin plus the step path and query; connector headers and the credential ride along', async () => {
    const h = harness();
    const res = await runHttpRequest(APP, MODEL, {
        kind: 'http_request', connectorId: 'conn_ab12cd', path: '/v1/orders/{{form.orderId}}',
        query: { region: { kind: 'formula', expr: 'vars.region' }, tag: { kind: 'static', value: ['a', 'b'] }, none: { kind: 'static', value: '' } },
        headers: { 'X-Trace': { kind: 'static', value: 'on' } },
    }, CTX, h.deps);
    assert.deepEqual(res, { ok: true, result: { status: 200, body: { ok: true } } });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, 'https://api.example.test/v1/orders/A%201%2F2?region=eu&tag=a&tag=b');
    const { init } = h.calls[0];
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { Accept: 'application/json', 'X-Trace': 'on', 'X-Api-Version': '2', 'X-Api-Key': 'tok-secret' });
});

test('the privacy check sees the path, query, own headers and body, never the credential or the connector headers', async () => {
    const h = harness();
    await runHttpRequest(APP, MODEL, {
        kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/v1/orders/{{item.id}}/notes',
        query: { q: { kind: 'static', value: 'x' } }, headers: { 'X-Trace': { kind: 'static', value: 'on' } },
        body: { kind: 'static', value: { text: '{{form.note}}', qty: '{{form.qty}}', label: 'n={{form.qty}}', gone: '{{vars.nothing}}' } },
        idempotencyKey: { kind: 'formula', expr: 'form.orderId' },
    }, { ...CTX, formValues: { ...CTX.formValues, orderId: 'ord-17' } }, h.deps);
    assert.deepEqual(h.checked, [['/v1/orders/7/notes', 'q=x', 'on', '{"text":"Deliver on Friday","qty":3,"label":"n=3","gone":null}', 'ord-17']]);
    assert.equal(JSON.stringify(h.checked).includes('tok-secret'), false);
    const { init } = h.calls[0];
    assert.equal(init.body, '{"text":"Deliver on Friday","qty":3,"label":"n=3","gone":null}');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['Idempotency-Key'], 'ord-17');
    // The ledger row: source studio_app, grouped per app, address and method only.
    assert.equal(h.ledger.length, 1);
    assert.deepEqual(h.ledger[0].toolArgs, { url: 'https://api.example.test/v1/orders/7/notes?q=x', method: 'POST' });
    assert.equal(h.ledger[0].auditBase.source, 'studio_app');
    assert.equal(h.ledger[0].auditBase.automation_id, 'app_1');
    assert.equal(h.ledger[0].policy.optOutHonoured, false);
    assert.equal(JSON.stringify(h.ledger).includes('tok-secret'), false);
});

test('a privacy finding fails the step with pii_blocked and sends nothing, whatever the organisation action is', async () => {
    const block = Object.assign(new Error('Blocked: sensitive data detected (Email Address)'), { guardrailBlocked: true, violationType: 'pii', categories: ['Email Address'] });
    const variants = {
        'block action (throws)': async () => { throw block; },
        'tokenize action (rewrites)': async (payload) => ({ value: payload.map(() => '[email_1]'), tokenMap: { '[email_1]': 'a@b.test' }, categories: ['Email Address'], markers: [] }),
        'an id-like field the pipeline let pass': async (payload) => ({ value: payload, tokenMap: null, categories: [], markers: ['identifier_passed_unredacted'] }),
    };
    for (const [name, guard] of Object.entries(variants)) {
        const h = harness({ guard });
        const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/v1/people', body: { kind: 'static', value: { mail: 'a@b.test' } } }, CTX, h.deps);
        assert.equal(res.ok, false, name);
        assert.equal(res.code, 'pii_blocked', name);
        assert.equal(res.retryable, false, name);
        assert.equal(h.calls.length, 0, `${name}: nothing sent`);
        assert.equal(h.ledger.length, 1, `${name}: one blocked row`);
        assert.equal(h.ledger[0].blocked, true, name);
        assert.equal(res.error.includes('a@b.test'), false, `${name}: the value is not in the message`);
    }
});

test('a privacy check that could not look at everything fails the step and sends nothing', async () => {
    const down = Object.assign(new Error('unavailable'), { guardrailBlocked: true, violationType: 'scan_failed', categories: ['privacy_protection_unavailable'] });
    for (const guard of [async () => { throw down; }, async (payload) => ({ value: payload, tokenMap: null, categories: [], markers: ['privacy_protection_unavailable'] }), async (payload) => ({ value: payload, tokenMap: null, categories: [], markers: ['scan_overflow'] })]) {
        const h = harness({ guard });
        const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/v1/x' }, CTX, h.deps);
        assert.equal(res.code, 'pii_check_unavailable');
        assert.equal(res.retryable, true);
        assert.equal(h.calls.length, 0);
    }
});

test('the connector must be a rest connector of this app', async () => {
    const h = harness();
    for (const connectorId of ['conn_mail01', 'conn_nope00', undefined, 'https://evil.example/']) {
        const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId, path: '/x' }, CTX, h.deps);
        assert.equal(res.code, 'http_connector_missing');
    }
    assert.equal(h.calls.length, 0);
});

test('headers a step may not set are refused: identity, framing and whatever the connector sets', async () => {
    for (const name of ['Authorization', 'authorization', 'Cookie', 'Proxy-Authorization', 'Host', 'Content-Length', 'Idempotency-Key', 'X-Api-Key', 'x-api-version', 'Bad Name', 'X:Y']) {
        const h = harness();
        const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x', headers: { [name]: { kind: 'static', value: 'v' } } }, CTX, h.deps);
        assert.equal(res.code, 'http_header_refused', name);
        assert.equal(h.calls.length, 0, name);
        assert.equal(h.checked.length, 0, name);
    }
    const h = harness();
    const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x', headers: { 'X-Note': { kind: 'static', value: 'a\r\nX-Evil: 1' } } }, CTX, h.deps);
    assert.equal(res.code, 'http_bad_input');
    assert.equal(h.calls.length, 0);
});

test('a missing credential fails the step instead of sending the request without it', async () => {
    const h = harness({ getProviderAuth: async () => null });
    const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x' }, CTX, h.deps);
    assert.equal(res.code, 'http_credential_unavailable');
    assert.equal(h.calls.length, 0);
});

test('the credential is asked for the app owner, never for the viewer', async () => {
    const asked = [];
    const h = harness({ getProviderAuth: async (userId, provider) => { asked.push([userId, provider]); return { accessToken: 't' }; } });
    await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x' }, CTX, h.deps);
    assert.deepEqual(asked, [['owner_1', 'acme']]);
});

test('dry run: a GET is sent, a write is simulated and reads no credential', async () => {
    const asked = [];
    const h = harness({ getProviderAuth: async (...a) => { asked.push(a); return { accessToken: 't' }; } });
    const get = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x' }, { ...CTX, dryRun: true }, h.deps);
    assert.equal(get.ok, true);
    assert.equal(h.calls.length, 1);
    asked.length = 0;
    const post = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'DELETE', path: '/v1/orders/{{item.id}}' }, { ...CTX, dryRun: true }, h.deps);
    assert.equal(post.ok, true);
    assert.equal(post.result.simulated, true);
    assert.deepEqual(post.result.wouldSend, { method: 'DELETE', url: 'https://api.example.test/v1/orders/7', headers: [], body: null });
    assert.match(post.notes[0], /^dryRun: DELETE https:\/\/api\.example\.test\/v1\/orders\/7 was not sent/);
    assert.equal(h.calls.length, 1, 'the write was not sent');
    assert.deepEqual(asked, []);
});

test('a status outside 200-299 fails the step; only a repeatable call is retryable', async () => {
    const run = (step, status) => {
        const h = harness({ respond: () => response(status, 'no') });
        return runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x', ...step }, CTX, h.deps);
    };
    assert.deepEqual(await run({}, 404), { ok: false, code: 'http_status', error: 'The service answered 404.', retryable: false, result: { status: 404 } });
    assert.equal((await run({}, 503)).retryable, true, 'a GET may be tried again');
    assert.equal((await run({ method: 'POST' }, 503)).retryable, false, 'a write without a key may not');
    assert.equal((await run({ method: 'POST', idempotencyKey: { kind: 'static', value: 'k-1' } }, 503)).retryable, true, 'a write that names itself may');
    assert.equal((await run({ method: 'POST', idempotencyKey: { kind: 'static', value: 'k-1' } }, 400)).retryable, false);
});

test('a failed or timed-out call: fixed sentences, and a write without a key is never retryable', async () => {
    const boom = () => { throw Object.assign(new Error('connect ECONNREFUSED 203.0.113.5:443 token=tok-secret'), { code: 'ECONNREFUSED' }); };
    const abort = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    const run = async (respond, step = {}) => {
        const h = harness({ respond });
        return [await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x', ...step }, CTX, h.deps), h];
    };
    const [down, h] = await run(boom);
    assert.deepEqual(down, { ok: false, code: 'http_unreachable', error: 'The service could not be reached.', retryable: true });
    assert.equal(h.ledger.length, 1);
    assert.equal(JSON.stringify(h.ledger).includes('tok-secret'), false, 'the transport text does not reach the ledger');
    assert.equal((await run(boom, { method: 'PUT' }))[0].retryable, false);
    assert.equal((await run(abort))[0].code, 'http_timeout');
    assert.equal((await run(abort, { method: 'PATCH' }))[0].retryable, false);
});

test('the answer: json by default (empty is null), text on request, not-JSON and oversize fail', async () => {
    const run = (body, step = {}) => {
        const h = harness({ respond: () => response(200, body) });
        return runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', path: '/x', ...step }, CTX, h.deps);
    };
    assert.deepEqual((await run('')).result, { status: 200, body: null });
    assert.deepEqual((await run('[1,2]')).result, { status: 200, body: [1, 2] });
    assert.deepEqual((await run('<p>hi</p>', { expect: 'text' })).result, { status: 200, body: '<p>hi</p>' });
    assert.equal((await run('<p>hi</p>')).code, 'http_not_json');
    assert.equal((await run('x'.repeat(1024 * 1024 + 1), { expect: 'text' })).code, 'http_response_too_large');
});

test('the body: json, form and text; a body that does not fit its format is refused before anything is checked or sent', async () => {
    const sent = async (step) => {
        const h = harness();
        const res = await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/x', ...step }, CTX, h.deps);
        return { res, init: h.calls[0]?.init, h };
    };
    const form = await sent({ bodyFormat: 'form', body: { kind: 'static', value: { a: '{{form.qty}}', b: ['x', 'y'] } } });
    assert.equal(form.init.body, 'a=3&b=x&b=y');
    assert.equal(form.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const text = await sent({ bodyFormat: 'text', body: { kind: 'static', value: 'Order {{form.orderId}}' } });
    assert.equal(text.init.body, 'Order A 1/2');
    const jsonText = await sent({ body: { kind: 'static', value: '{"note": "{{form.note}}"}' } });
    assert.equal(jsonText.init.body, '{"note":"Deliver on Friday"}');
    const fromVar = await sent({ body: { kind: 'formula', expr: 'vars.payload' } });
    assert.equal(fromVar.init.body, undefined, 'a body that resolves to nothing sends none');
    const own = await sent({ headers: { 'Content-Type': { kind: 'static', value: 'application/vnd.api+json' } }, body: { kind: 'static', value: { a: 1 } } });
    assert.equal(own.init.headers['Content-Type'], 'application/vnd.api+json');
    const bad = await sent({ bodyFormat: 'form', body: { kind: 'static', value: { a: { nested: true } } } });
    assert.equal(bad.res.code, 'http_bad_input');
    assert.equal(bad.h.calls.length + bad.h.checked.length, 0);
    const notJson = await sent({ body: { kind: 'static', value: 'not json' } });
    assert.equal(notJson.res.code, 'http_bad_input');
});

test('a value read from data is never read as a template again', async () => {
    const h = harness();
    await runHttpRequest(APP, MODEL, {
        kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/x',
        body: { kind: 'static', value: { note: '{{form.note}}', raw: 'x {{form.note}}' } },
    }, { ...CTX, formValues: { note: '{{vars.region}}' } }, h.deps);
    assert.equal(h.calls[0].init.body, '{"note":"{{vars.region}}","raw":"x {{vars.region}}"}');
    const viaFormula = harness();
    await runHttpRequest(APP, MODEL, { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/x', bodyFormat: 'text', body: { kind: 'formula', expr: 'form.note' } }, { ...CTX, formValues: { note: '{{vars.region}}' } }, viaFormula.deps);
    assert.equal(viaFormula.calls[0].init.body, '{{vars.region}}');
});

test('limits from the environment: body size and time, 0 means none', async () => {
    const big = { kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/x', bodyFormat: 'text', body: { kind: 'static', value: 'y'.repeat(200) } };
    const capped = harness({ env: { STUDIO_APP_HTTP_MAX_BODY_BYTES: '100' } });
    assert.equal((await runHttpRequest(APP, MODEL, big, CTX, capped.deps)).code, 'http_body_too_large');
    assert.equal(capped.calls.length, 0);
    const open = harness({ env: { STUDIO_APP_HTTP_MAX_BODY_BYTES: '0', STUDIO_APP_HTTP_TIMEOUT_MS: '0' } });
    assert.equal((await runHttpRequest(APP, MODEL, big, CTX, open.deps)).ok, true);
});

test('the dispatcher runs the kind through its registry file and never throws', async () => {
    const res = await executeDataStep(APP, MODEL, { kind: 'http_request', connectorId: 'conn_nope00' }, CTX);
    assert.deepEqual(res, { ok: false, code: 'http_connector_missing', error: 'This step names a connection that is not a REST connection of this app.', retryable: false });
});
