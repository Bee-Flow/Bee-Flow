/**
 * What the staff catalogue routes accept, and what they say when they refuse
 * (routes/support/tags.js, slaPolicies.js, cannedResponses.js, aiConfig.js,
 * mailbox.js — the five that take a body).
 *
 * Every one of them read a flag the loose way. `enabled !== false` on an SLA
 * policy and `!!v2Enabled` on the AI config both mean "anything that is not
 * the boolean false is ON", so switching a clock or the tool-using responder
 * off with the STRING 'false' answered 200 and left it running. A misspelled
 * `colour` on a tag, or `shortcutt` on a canned response, was dropped on the
 * way through and the row arrived without it. What this file pins is the part
 * a caller can act on:
 *
 *   - the 400 NAMES the field (`body.enabled`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing;
 *   - the 403 still comes FIRST, so a schema never tells a stranger the
 *     endpoint is there;
 *   - and the bodies the support tabs really send still save.
 *
 * Run: cd server && node --test routes/support/catalogues.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const rec = (what) => async (...args) => { touched.push({ what, args }); return { ok: true }; };

// Flipped per test to check that the gate answers before the schema does.
const access = { staff: true, superAdmin: true };

const supportStore = {
    listTags: async () => [],
    createTag: async (p) => { touched.push({ what: 'createTag', args: [p] }); return { id: 't1', ...p }; },
    deleteTag: rec('deleteTag'),
    listSlaPolicies: async () => [],
    upsertSlaPolicy: async (p) => { touched.push({ what: 'upsertSlaPolicy', args: [p] }); return { ...p }; },
    listCannedResponses: async () => [],
    getCannedResponse: async () => ({ id: 'c1', body: 'Hi {{name}}' }),
    createCannedResponse: async (p) => { touched.push({ what: 'createCannedResponse', args: [p] }); return { id: 'c1', ...p }; },
    updateCannedResponse: async (id, patch) => { touched.push({ what: 'updateCannedResponse', args: [id, patch] }); return { id, ...patch }; },
    deleteCannedResponse: rec('deleteCannedResponse'),
    getThread: async (id) => ({ id, subject: 's', requester_name: 'n' }),
    getCompanyMailboxSummary: async () => ({ count: 0 }),
    deleteMailboxThreads: rec('deleteMailboxThreads'),
    recordAuditEvent: async () => {},
};

const configStore = {
    getConfig: async () => null,
    setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); },
};

const sharedStub = {
    getUserId: () => 'u1',
    getUserDisplay: () => 'Staff',
    _hasAdminSupport: async () => access.staff,
    requireStaffSupport: (req, res, next) => (access.staff ? next() : res.status(403).json({ error: 'admin_support permission required' })),
    _actingOrgId: async () => 'orgA',
    renderCannedBody: (body) => `rendered:${body}`,
    _emit: () => {},
};

const MOCKS = {
    '../../stores/supportStore': supportStore,
    '../../stores/configStore': configStore,
    '../../auth': { isSuperAdmin: () => access.superAdmin },
    './shared': sharedStub,
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:support-catalogues-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /support[\\/](tags|slaPolicies|cannedResponses|aiConfig|mailbox)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = express.Router();
require('./tags').register(router);
require('./slaPolicies').register(router);
require('./cannedResponses').register(router);
require('./aiConfig').register(router);
require('./mailbox').register(router);
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

test.beforeEach(() => { touched.length = 0; access.staff = true; access.superAdmin = true; });

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

// ═══ POST /tags ════════════════════════════════════════════════════

test('a tag with no name is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/tags', body: {} }, 'body.name');
    assert.strictEqual(res.body.error, 'A tag needs a name.');
});

test('a misspelled colour is refused rather than answered with a tag that has none', async () => {
    await refuses({ method: 'POST', url: '/tags', body: { name: 'Billing', colour: '#f00' } }, 'body');
});

test('a name over fifty characters keeps its cap, now as a sentence', async () => {
    const res = await refuses({ method: 'POST', url: '/tags', body: { name: 'x'.repeat(51) } }, 'body.name');
    assert.strictEqual(res.body.error, 'A tag name is at most 50 characters.');
});

test('the tag body the tags tab sends still saves, trimmed once', async () => {
    const res = await dispatch({ method: 'POST', url: '/tags', body: { name: '  Billing  ', color: '#64748b' } });
    assert.strictEqual(res.statusCode, 200);
    const tag = touched.find((t) => t.what === 'createTag').args[0];
    assert.strictEqual(tag.name, 'Billing');
    assert.strictEqual(tag.color, '#64748b');
});

test('a stranger gets the 403 before the schema ever looks at the body', async () => {
    access.staff = false;
    const res = await dispatch({ method: 'POST', url: '/tags', body: { colour: 'nonsense' } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

// ═══ PUT /sla-policies ═════════════════════════════════════════════

test('"enabled" as the string "false" is refused, not read as "leave the clock on"', async () => {
    const res = await refuses({
        method: 'PUT', url: '/sla-policies',
        body: { priority: 'high', first_response_minutes: 30, resolution_minutes: 240, enabled: 'false' },
    }, 'body.enabled');
    assert.strictEqual(res.body.error, 'enabled is true or false.');
});

test('a misspelled priority is refused by name instead of arriving as a store exception', async () => {
    const res = await refuses({
        method: 'PUT', url: '/sla-policies',
        body: { priority: 'urgnet', first_response_minutes: 30, resolution_minutes: 240 },
    }, 'body.priority');
    assert.strictEqual(res.body.error, 'priority is one of: low, normal, high, urgent.');
});

test('a resolution clock of zero minutes is refused in words', async () => {
    const res = await refuses({
        method: 'PUT', url: '/sla-policies',
        body: { priority: 'low', first_response_minutes: 60, resolution_minutes: 0 },
    }, 'body.resolution_minutes');
    assert.strictEqual(res.body.error, 'resolution_minutes is a whole number of minutes, at least 1.');
});

test('the SLA row the tab saves still reaches the store, and switching off really switches off', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/sla-policies',
        body: { priority: 'urgent', first_response_minutes: 15, resolution_minutes: 240, enabled: false },
    });
    assert.strictEqual(res.statusCode, 200);
    const p = touched.find((t) => t.what === 'upsertSlaPolicy').args[0];
    assert.strictEqual(p.priority, 'urgent');
    assert.strictEqual(p.firstResponseMinutes, 15);
    assert.strictEqual(p.enabled, false);
});

// ═══ /canned ═══════════════════════════════════════════════════════

test('a misspelled shortcut is refused rather than saved without its "/" trigger', async () => {
    await refuses({ method: 'POST', url: '/canned', body: { title: 'Refund', body: 'Hi', shortcutt: '/refund' } }, 'body');
});

test('a canned response whose body is only spaces is refused in words', async () => {
    const res = await refuses({ method: 'POST', url: '/canned', body: { title: 'Refund', body: '   ' } }, 'body.body');
    assert.strictEqual(res.body.error, 'A canned response needs a body.');
});

test('the draft the canned-responses tab posts — title, shortcut and body — still saves', async () => {
    const res = await dispatch({ method: 'POST', url: '/canned', body: { title: 'Refund', shortcut: '/refund', body: 'We will refund you.' } });
    assert.strictEqual(res.statusCode, 200);
    const c = touched.find((t) => t.what === 'createCannedResponse').args[0];
    assert.strictEqual(c.shortcut, '/refund');
    assert.strictEqual(c.body, 'We will refund you.');
});

test('a null title on update is a named 400, not the 500 that .toString() used to throw', async () => {
    const res = await refuses({ method: 'PUT', url: '/canned/c1', body: { title: null } }, 'body.title');
    assert.strictEqual(res.body.error, 'A canned response needs a title.');
});

test('an update that only moves the shortcut still reaches the store as one key', async () => {
    const res = await dispatch({ method: 'PUT', url: '/canned/c1', body: { shortcut: '/rf' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateCannedResponse').args[1], { shortcut: '/rf' });
});

test('the render route still takes the thread id the composer sends, and nothing else', async () => {
    const ok = await dispatch({ method: 'POST', url: '/canned/c1/render', body: { threadId: 'th-1' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.rendered, 'rendered:Hi {{name}}');
    await refuses({ method: 'POST', url: '/canned/c1/render', body: { thread_id: 'th-1' } }, 'body');
});

// ═══ PUT /config ═══════════════════════════════════════════════════

test('"v2Enabled" as the string "false" is refused, not read as switching the responder ON', async () => {
    const res = await refuses({ method: 'PUT', url: '/config', body: { v2Enabled: 'false' } }, 'body.v2Enabled');
    assert.strictEqual(res.body.error, 'v2Enabled is true or false.');
});

test('a misspelled config key is refused rather than answered with { ok: true } and no change', async () => {
    await refuses({ method: 'PUT', url: '/config', body: { kbids: ['kb1'] } }, 'body');
});

test('a threshold outside 0..1 is refused in words', async () => {
    const res = await refuses({ method: 'PUT', url: '/config', body: { autoResolveThreshold: 1.4 } }, 'body.autoResolveThreshold');
    assert.strictEqual(res.body.error, 'autoResolveThreshold is a number between 0 and 1.');
});

test('the tools tab body still saves, and switching v2 off really writes false', async () => {
    const res = await dispatch({ method: 'PUT', url: '/config', body: { v2Enabled: false, autoResolveThreshold: 0.9 } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.args[0] === 'support_ai_v2_enabled').args, ['support_ai_v2_enabled', false]);
    assert.deepStrictEqual(touched.find((t) => t.args[0] === 'support_ai_autoresolve_threshold').args, ['support_ai_autoresolve_threshold', 0.9]);
});

test('a caller who is not a super-admin gets the 403 before the schema', async () => {
    access.superAdmin = false;
    const res = await dispatch({ method: 'PUT', url: '/config', body: { kbids: 'nonsense' } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

// ═══ POST /preview and POST /mailbox/disconnect ════════════════════

test('a preview with no message is refused in words', async () => {
    const res = await refuses({ method: 'POST', url: '/preview', body: {} }, 'body.message');
    assert.strictEqual(res.body.error, 'A preview needs a message.');
});

test('the disconnect button posts an empty body and is answered, not refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/mailbox/disconnect', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removed, 0);
});

test('a key on the disconnect route is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/mailbox/disconnect', body: { purge: true } }, 'body');
});
