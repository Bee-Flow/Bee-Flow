/**
 * What the YouTrack-link and chat-notifier routes accept, and what they say
 * when they refuse (routes/support/issueLinks.js).
 *
 * Two of the flags here were switches that did not switch off, and one of
 * them is the BFSF-441 line itself:
 *
 *   - `includeSubject` was stored as `includeSubject ? 'true' : 'false'`, so
 *     the STRING 'false' stored 'true'. A ticket's subject often carries a
 *     name or a company; turning it off is how an admin keeps it out of
 *     YouTrack. Sending the string turned it ON, answered 200, and from then
 *     on every issue carried the subject.
 *   - `enabled` on the chat notifier had the same shape, so switching the
 *     outbound feed off left it running.
 *   - `events` was worse: the route filtered the list down to the names it
 *     knew, so one misspelled name became an empty list — every notification
 *     off, under `{ ok: true }`.
 *
 * What this file pins is the part a caller can act on: the 400 names the
 * field, the message is a sentence, nothing is written, and the bodies
 * SupportConnectionsConfig and AttachIssuePanel really send still save.
 *
 * Run: cd server && node --test routes/support/issueLinks.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];
const access = { staff: true };

const thread = { id: 'th-1', ticket_ref: 'T-1', subject: 'Cannot log in', priority: 'normal', organization_id: 'orgA' };

const EVENTS = ['new_ticket', 'escalation', 'sla_breach'];
const PROVIDERS = ['google_chat', 'slack'];

const MOCKS = {
    '../../stores/supportStore': {
        getThread: async () => thread,
        listIssueLinks: async () => [],
        countThreadsPerIssue: async () => ({}),
        listThreadsForIssue: async () => [],
        linkIssue: async (p) => { touched.push({ what: 'linkIssue', args: [p] }); return { issue_id: p.issueId, link_kind: p.linkKind, link_reason: p.linkReason }; },
        unlinkIssue: async () => true,
        clearFollowup: async () => true,
        updateThread: async (id, patch) => { touched.push({ what: 'updateThread', args: [id, patch] }); return thread; },
        recordThreadEvent: async () => {},
        recordAuditEvent: async () => {},
    },
    '../../stores/configStore': {
        setSecret: async (key, value) => { touched.push({ what: 'setSecret', args: [key, value] }); },
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); },
        getConfig: async () => null,
    },
    '../../integrations/youtrackClient': {
        SERVICE_URL_KEY: 'yt_url', SERVICE_TOKEN_KEY: 'yt_token', SERVICE_PROJECT_KEY: 'yt_project',
        ISSUE_ID_RE: /^[A-Z][A-Z0-9_]*-\d+$/,
        ping: async () => ({ connected: true }),
        resolveCredentials: async () => ({ baseUrl: 'https://yt.example' }),
        getIssue: async (creds, id) => ({ id, summary: 's', state: 'Open', resolved: false }),
        searchIssues: async () => [],
        getDefaultProject: async () => 'BFSF',
        issueUrl: (base, id) => `${base}/issue/${id}`,
        createIssue: async () => ({ id: 'BFSF-9', summary: 's' }),
        addTag: async () => {},
    },
    '../../support/issueEgress': {
        SUBJECT_KEY: 'support_issue_include_subject',
        includeSubjectEnabled: async () => false,
        buildIssuePayload: () => ({ summary: 'S', description: 'D', ticketRef: 'T-1' }),
        screenText: async () => ({ ok: true, scanned: true, findings: [] }),
        describeFindings: () => '',
    },
    '../../services/outboundChatNotifier': {
        WEBHOOK_KEY: 'chat_hook', PROVIDER_KEY: 'chat_provider', ENABLED_KEY: 'chat_enabled', EVENTS_KEY: 'chat_events',
        PROVIDERS, EVENTS,
        getPublicSettings: async () => ({ enabled: false, events: [] }),
        sendTest: async () => ({ ok: true }),
        notify: async (n) => { touched.push({ what: 'notify', args: [n] }); return { sent: true }; },
    },
    '../../services/supportIssueSync': {
        syncThread: async () => [],
        linkBaseline: async (creds, issue) => ({
            issueSummary: issue?.summary || null, issueState: issue?.state || null,
            issueResolved: !!issue?.resolved, commentsSeeded: !!issue,
        }),
    },
    './shared': {
        getUserId: () => 'u1',
        _hasAdminSupport: async () => access.staff,
        requireStaffSupport: (req, res, next) => (access.staff ? next() : res.status(403).json({ error: 'admin_support permission required' })),
        _emit: () => {},
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:support-issuelinks-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /support[\\/]issueLinks\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = express.Router();
require('./issueLinks').register(router);
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

test.beforeEach(() => { touched.length = 0; access.staff = true; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not write anything');
    return res;
}

// ═══ PUT /youtrack/connection — the BFSF-441 switch ════════════════

test('"includeSubject" as the string "false" is refused, not stored as "true"', async () => {
    const res = await refuses({ method: 'PUT', url: '/youtrack/connection', body: { includeSubject: 'false' } }, 'body.includeSubject');
    assert.strictEqual(res.body.error, 'includeSubject is true or false.');
});

test('switching the subject off really writes "false"', async () => {
    const res = await dispatch({ method: 'PUT', url: '/youtrack/connection', body: { project: 'BFSF', includeSubject: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.args[0] === 'support_issue_include_subject').args,
        ['support_issue_include_subject', 'false']);
});

test('the connection body the settings tab sends still saves', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/youtrack/connection',
        body: { url: 'https://yt.example/', token: 'perm-abc', project: 'BFSF', includeSubject: true },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.args[0] === 'yt_url').args[1], 'https://yt.example');
    assert.strictEqual(touched.find((t) => t.args[0] === 'yt_project').args[1], 'BFSF');
});

test('a plain-http URL keeps its own refusal', async () => {
    const res = await dispatch({ method: 'PUT', url: '/youtrack/connection', body: { url: 'http://yt.example' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'URL must start with https://');
});

test('a misspelled connection key is refused rather than dropped under a 200', async () => {
    await refuses({ method: 'PUT', url: '/youtrack/connection', body: { includeSubjects: true } }, 'body');
});

// ═══ PUT /notifications ════════════════════════════════════════════

test('"enabled" as the string "false" is refused, not read as switching the feed ON', async () => {
    const res = await refuses({ method: 'PUT', url: '/notifications', body: { enabled: 'false' } }, 'body.enabled');
    assert.strictEqual(res.body.error, 'enabled is true or false.');
});

test('a misspelled event name is named, instead of quietly emptying the whole list', async () => {
    const res = await dispatch({ method: 'PUT', url: '/notifications', body: { events: ['new_ticket', 'escalaton'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'unknown event "escalaton"');
    assert.deepStrictEqual(res.body.allowed, EVENTS);
    assert.ok(!touched.some((t) => t.args[0] === 'chat_events'), 'nothing is written when one name is wrong');
});

test('the event list the settings tab sends still saves', async () => {
    const res = await dispatch({ method: 'PUT', url: '/notifications', body: { events: ['new_ticket', 'sla_breach'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.args[0] === 'chat_events').args[1], JSON.stringify(['new_ticket', 'sla_breach']));
});

test('an unknown provider keeps its own refusal', async () => {
    const res = await dispatch({ method: 'PUT', url: '/notifications', body: { provider: 'teams' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'unknown provider');
});

// ═══ POST /threads/:id/issues ══════════════════════════════════════

test('a misspelled attach key is refused rather than answered with "issueIds required"', async () => {
    await refuses({ method: 'POST', url: '/threads/th-1/issues', body: { issueIDs: ['BFSF-441'] } }, 'body');
});

test('the tick-and-attach body the panel sends still links', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/issues', body: { issueIds: ['BFSF-441', 'BFSF-442'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.filter((t) => t.what === 'linkIssue').map((t) => t.args[0].issueId), ['BFSF-441', 'BFSF-442']);
    // BFSF-446: the link records the issue as it is now, so the next sync
    // does not report an old comment as a follow-up.
    assert.ok(touched.filter((t) => t.what === 'linkIssue').every((t) => t.args[0].commentsSeeded === true));
});

test('an id that is not a YouTrack id keeps its own answer, which quotes the id', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/issues', body: { issueIds: ['not an id'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'invalid issue id: not an id');
});

// ═══ POST /threads/:id/issues/create ═══════════════════════════════

test('a misspelled create key is refused rather than filing an issue without it', async () => {
    await refuses({ method: 'POST', url: '/threads/th-1/issues/create', body: { summary: 'S', desc: 'D' } }, 'body');
});

test('the create body the panel sends still reaches the egress screen and the client', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/issues/create', body: { summary: 'Login fails', description: 'Steps…' } });
    assert.strictEqual(res.statusCode, 200);
    // A brand-new issue has no comments: that is a known baseline (BFSF-446).
    assert.strictEqual(touched.find((t) => t.what === 'linkIssue').args[0].commentsSeeded, true);
});

// ═══ POST /threads/:id/escalate ════════════════════════════════════

test('an escalation with no reason is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/threads/th-1/escalate', body: {} }, 'body.reason');
    assert.strictEqual(res.body.error, 'An escalation needs a reason.');
});

test('"raisePriority" as the string "false" is refused, not read as raising it', async () => {
    const res = await refuses({ method: 'POST', url: '/threads/th-1/escalate', body: { reason: 'Data loss', raisePriority: 'false' } }, 'body.raisePriority');
    assert.strictEqual(res.body.error, 'raisePriority is true or false.');
});

test('an escalation with a reason and a real flag still raises the priority and links', async () => {
    const res = await dispatch({ method: 'POST', url: '/threads/th-1/escalate', body: { reason: 'Data loss', issueId: 'BFSF-441', raisePriority: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateThread').args[1].priority, 'high');
    assert.strictEqual(touched.find((t) => t.what === 'linkIssue').args[0].linkKind, 'escalated');
    assert.strictEqual(touched.find((t) => t.what === 'linkIssue').args[0].commentsSeeded, true);

    // BFSF-448: the escalation event has a sender. The card gets the raised
    // priority and the issue id; the typed reason never leaves.
    const sent = touched.find((t) => t.what === 'notify').args[0];
    assert.strictEqual(sent.event, 'escalation');
    assert.strictEqual(sent.thread.priority, 'high');
    assert.strictEqual(sent.detail, 'Linked issue: BFSF-441');
    assert.ok(!JSON.stringify(sent).includes('Data loss'));
});

// ═══ The buttons that post nothing ═════════════════════════════════

test('the refresh, test and follow-up buttons post an empty body and are answered', async () => {
    assert.strictEqual((await dispatch({ method: 'POST', url: '/threads/th-1/issues/refresh', body: {} })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'POST', url: '/notifications/test', body: {} })).statusCode, 200);
    assert.strictEqual((await dispatch({ method: 'POST', url: '/threads/th-1/followup-done', body: {} })).statusCode, 200);
});

test('a key on the follow-up button is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/threads/th-1/followup-done', body: { force: true } }, 'body');
});

// ═══ GET /youtrack/search ══════════════════════════════════════════

test('the panel\'s search — including its empty threadId — still reaches YouTrack', async () => {
    const res = await dispatch({ method: 'GET', url: '/youtrack/search?q=login&threadId=' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.issues, []);
});

test('a misspelled search key is refused rather than dropped into an unscoped search', async () => {
    const res = await dispatch({ method: 'GET', url: '/youtrack/search?query=login' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
});
