/**
 * What the ticket routes accept, and what they say when they refuse
 * (routes/support/threads.js).
 *
 * Three silent fallbacks lived here, all under a 200:
 *
 *   - `internalNote` was `!!req.body?.internalNote`, so the STRING 'false'
 *     made a staff reply an INTERNAL note. The composer said "sent", the note
 *     sat in the thread, and the customer never got it.
 *   - `tags` was applied only `if (Array.isArray(tags))`, so `tags: 'billing'`
 *     was dropped and the thread came back with its old labels.
 *   - `GET /threads?staus=open` dropped the filter and answered with the whole
 *     inbox, resolved and closed tickets included.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.internalNote`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing;
 *   - the 403 still comes first for the staff-only routes;
 *   - and the bodies SupportInboxPanel, SupportDrawer, the marketing form and
 *     the mobile client really send still work.
 *
 * Run: cd server && node --test routes/support/threads.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const access = { staff: true };

const thread = {
    id: 'th-1', subject: 'Cannot log in', status: 'open', priority: 'normal',
    requester_email: 'a@example.org', requester_name: 'A', requester_user_id: null, tags: [],
};

const supportStore = {
    createThread: async (p) => { touched.push({ what: 'createThread', args: [p] }); return { ...thread, ...p }; },
    getThread: async () => thread,
    getThreadMessages: async () => [],
    listThreads: async (opts) => { touched.push({ what: 'listThreads', args: [opts] }); return []; },
    countThreadsByStatus: async () => ({}),
    countFollowupNeeded: async () => 0,
    appendMessage: async (p) => { touched.push({ what: 'appendMessage', args: [p] }); return { id: 'm1', ...p }; },
    updateThread: async (id, patch) => { touched.push({ what: 'updateThread', args: [id, patch] }); return { ...thread, ...patch }; },
    setThreadTags: async (id, tags) => { touched.push({ what: 'setThreadTags', args: [id, tags] }); return { ...thread, tags }; },
    addThreadTag: async (id, tag) => { touched.push({ what: 'addThreadTag', args: [id, tag] }); return thread; },
    recordThreadEvent: async () => {},
    listThreadEvents: async () => [],
    setThreadSla: async () => {},
    firstStaffReplyTransition: async () => ({}),
    verifyAccessToken: () => true,
    buildAccessToken: () => 'tok',
    buildCsatToken: () => 'tok',
};

const pass = (req, res, next) => next();
const MOCKS = {
    '../../stores/supportStore': supportStore,
    '../../stores/userStore': { getUser: async () => null },
    '../../stores/notificationStore': { createNotification: async () => {} },
    '../../core/http/sseHelpers': { setupSSE: () => ({ sendEvent() {}, markEnded() {} }), startSseHeartbeat: () => () => {} },
    '../../utils/appPaths': { supportThreadPath: () => '/x', clientHost: () => '', adminSupportTabPath: () => '/x', appRootPath: () => '/app' },
    '../../auth': { resolveUserOrgIds: async () => null },
    '../../services/supportAiResponder': { runAiAutoResponder: async () => null },
    '../../services/supportSlaEnforcer': { computeSlaDueAt: async () => ({ first: null, resolution: null }) },
    '../../support/emails': {
        sendThreadCreatedEmail: async () => {}, sendAiReplyEmail: async () => {},
        sendStaffReplyEmail: async () => {}, sendThreadResolvedEmail: async () => {},
        sendOrNotifyStaff: () => {},
    },
    './shared': {
        _redactEmail: () => '(x)', _shortId: (v) => String(v).slice(0, 8), _notifExcerpt: (v) => v,
        getUserId: () => (access.staff ? 'u1' : null),
        getUserDisplay: () => 'Staff',
        _hasAdminSupport: async () => access.staff,
        requireStaffSupport: (req, res, next) => (access.staff ? next() : res.status(403).json({ error: 'admin_support permission required' })),
        _buildThreadUrl: () => 'https://x/y', _buildCsatLinks: () => ({ stars: [], dispute: '' }),
        supportEvents: { on() {}, off() {}, listenerCount: () => 0 },
        _emit: () => {}, _logListenerPressure: () => {}, notifyStaff: async () => {},
    },
    './rateLimits': { publicCreateLimiter: pass, threadReadLimiter: pass, _emailRateLimitOk: () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:support-threads-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /support[\\/]threads\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const threads = require('./threads');
const router = express.Router();
threads.registerThreadRoutes(router);
threads.registerBulkRoute(router);
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: access.staff ? { user: { id: 'u1' } } : {}, get() { return undefined; },
            on() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, on() {},
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

test.beforeEach(() => { touched.length = 0; access.staff = true; });

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

// ═══ POST /threads/:id/messages — the reply that reaches a customer ═

test('"internalNote" as the string "false" is refused, not read as "make it internal"', async () => {
    const res = await refuses({ method: 'POST', url: '/threads/th-1/messages', body: { body: 'We are on it.', internalNote: 'false' } }, 'body.internalNote');
    assert.strictEqual(res.body.error, 'internalNote is true or false.');
});

test('a reply the composer sends without the flag still goes to the customer', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/messages', body: { body: 'We are on it.', internalNote: false } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'appendMessage').args[0].internalNote, false);
});

test('a real internal note is still internal', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/messages', body: { body: 'Checked the logs.', internalNote: true } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'appendMessage').args[0].internalNote, true);
});

test('an empty reply is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/threads/th-1/messages', body: { body: '   ' } }, 'body.body');
    assert.strictEqual(res.body.error, 'A reply needs a body.');
});

test('the requester\'s token still reaches the access check, and a typo beside it does not pass', async () => {
    const ok = await dispatch({ method: 'POST', url: '/threads/th-1/messages?token=abc', body: { body: 'Still broken.' } });
    assert.strictEqual(ok.statusCode, 201);
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/messages?tokn=abc', body: { body: 'x' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
});

// ═══ PATCH /threads/:id ════════════════════════════════════════════

test('tags as a bare string are refused rather than dropped, leaving the old labels', async () => {
    const res = await refuses({ method: 'PATCH', url: '/threads/th-1', body: { tags: 'billing' } }, 'body.tags');
    assert.strictEqual(res.body.error, 'tags is a list of labels.');
});

test('a misspelled patch key is refused rather than answered with an unchanged thread', async () => {
    await refuses({ method: 'PATCH', url: '/threads/th-1', body: { priorty: 'urgent' } }, 'body');
});

test('a misspelled status is refused in words that list the six', async () => {
    const res = await refuses({ method: 'PATCH', url: '/threads/th-1', body: { status: 'resolvd' } }, 'body.status');
    assert.strictEqual(res.body.error,
        'status is one of: open, ai_responding, awaiting_user, awaiting_agent, resolved, closed.');
});

test('the tag edit the inbox panel sends still reaches setThreadTags', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/threads/th-1', body: { tags: ['billing', 'refund'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setThreadTags').args[1], ['billing', 'refund']);
});

test('resolving from the panel still stamps resolved_at', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/threads/th-1', body: { status: 'resolved' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.find((t) => t.what === 'updateThread').args[1].resolved_at);
});

test('unassigning still reaches the store as a real null and clears auto_assigned', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/threads/th-1', body: { assignee_user_id: null } });
    assert.strictEqual(res.statusCode, 200);
    const patch = touched.find((t) => t.what === 'updateThread').args[1];
    assert.strictEqual(patch.assignee_user_id, null);
    assert.strictEqual(patch.auto_assigned, false);
});

// ═══ GET /threads — the staff inbox ════════════════════════════════

test('a misspelled filter key is refused, not answered with the whole inbox', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?staus=open' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, []);
});

test('a status that is not one of the six is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?status=open,resolvd' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.error.startsWith('status is a comma-separated list of:'));
});

test('the "active" chip\'s comma list still reaches the store as four statuses', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?status=open,ai_responding,awaiting_user,awaiting_agent' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'listThreads').args[0].statusIn,
        ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent']);
});

test('the follow-up chip still selects the follow-up queue', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?followup=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listThreads').args[0].followupOnly, true);
});

test('a followup value that is not a flag is refused rather than read as "no"', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?followup=yes' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'followup is one of: 1, 0, true, false.');
});

test('a limit that is not a number is refused instead of reaching the query as NaN', async () => {
    const res = await dispatch({ method: 'GET', url: '/threads?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit is a whole number.');
});

test('a stranger gets the 403 before the query schema looks at anything', async () => {
    access.staff = false;
    const res = await dispatch({ method: 'GET', url: '/threads?staus=open' });
    assert.strictEqual(res.statusCode, 403);
});

// ═══ POST /threads — the public create ═════════════════════════════

test('the marketing form body — honeypot and render time included — still creates', async () => {
    const res = await dispatch({
        method: 'POST', url: '/threads',
        body: {
            source: 'marketing', name: 'A', email: 'a@example.org',
            subject: 'Cannot log in', message: 'It says my password is wrong.',
            website_url: '', rendered_at_ms: Date.now() - 10000,
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.ok(touched.some((t) => t.what === 'createThread'));
});

test('a bot that fills the honeypot is still answered 200 with nothing stored', async () => {
    const res = await dispatch({
        method: 'POST', url: '/threads',
        body: { source: 'marketing', subject: 'x', message: 'y', website_url: 'http://spam.example' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.spam, true);
    assert.deepStrictEqual(touched, []);
});

test('the in-app body the drawer and the mobile client send still creates', async () => {
    const res = await dispatch({
        method: 'POST', url: '/threads',
        body: { subject: 'Cannot log in', message: 'It says my password is wrong.', source: 'in_app' },
    });
    assert.strictEqual(res.statusCode, 201);
});

test('an empty subject is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/threads', body: { message: 'y' } }, 'body.subject');
    assert.strictEqual(res.body.error, 'A support request needs a subject.');
});

test('a source outside the two is refused rather than quietly read as "marketing"', async () => {
    const res = await refuses({ method: 'POST', url: '/threads', body: { subject: 'x', message: 'y', source: 'in-app' } }, 'body.source');
    assert.strictEqual(res.body.error, 'source is one of: marketing, in_app.');
});

// ═══ POST /threads/bulk ════════════════════════════════════════════

test('a misspelled bulk action is refused in words that list the five', async () => {
    const res = await refuses({ method: 'POST', url: '/threads/bulk', body: { ids: ['th-1'], action: 'resovle' } }, 'body.action');
    assert.strictEqual(res.body.error, 'action is one of: assign, status, priority, tag, resolve.');
});

test('a misspelled key inside params is refused rather than leaving the action with nothing to do', async () => {
    await refuses({ method: 'POST', url: '/threads/bulk', body: { ids: ['th-1'], action: 'tag', params: { label: 'billing' } } }, 'body.params');
});

test('a bulk priority outside the four is refused before any thread is touched', async () => {
    await refuses({ method: 'POST', url: '/threads/bulk', body: { ids: ['th-1'], action: 'priority', params: { priority: 'urgnet' } } }, 'body.params.priority');
});

test('the bulk actions the toolbar sends still run', async () => {
    const tagged = await dispatch({ method: 'POST', url: '/threads/bulk', body: { ids: ['th-1'], action: 'tag', params: { tag: 'billing' } } });
    assert.strictEqual(tagged.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'addThreadTag').args, ['th-1', 'billing']);

    touched.length = 0;
    const resolved = await dispatch({ method: 'POST', url: '/threads/bulk', body: { ids: ['th-1'], action: 'resolve', params: {} } });
    assert.strictEqual(resolved.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateThread').args[1].status, 'resolved');
});
