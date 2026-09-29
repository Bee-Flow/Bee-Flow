/**
 * Unit tests for the YouTrack tool module — duplicate-prevention guard,
 * timeout verification, and the extended tool set.
 *
 * Run: node --test integrations/youtrackTools.test.js
 *
 * No network/DB needed — `configStore` is stubbed (same trick as
 * afasTools.test.js) and `global.fetch` is scripted per case.
 */

const test = require('node:test');
const assert = require('assert');

// Stub configStore before requiring the module under test.
const SECRETS = {};
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getSecret: async (key) => SECRETS[key] ?? null,
    },
};

const {
    executeYouTrackTool,
    isYouTrackTool,
    YOUTRACK_TOOLS,
    normalizeSummary,
    __setVerifyDelayMs,
} = require('./youtrackTools');

__setVerifyDelayMs(1); // no real sleeping in tests

const USER = 'u1';
SECRETS[`youtrack_url_user_${USER}`] = 'https://yt.example.com';
SECRETS[`youtrack_token_user_${USER}`] = 'perm:token';

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
    // responses: one entry per expected request, in order.
    //   { status, body }        → HTTP response (body JSON-encoded)
    //   { throwName: 'TimeoutError' } → fetch itself throws (timeout/network)
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        const r = responses[fetchCalls.length];
        fetchCalls.push({ url: String(url), opts });
        if (r === undefined) throw new Error(`Unexpected upstream request #${fetchCalls.length}: ${url}`);
        if (r.throwName) {
            const e = new Error(r.throwName);
            e.name = r.throwName;
            throw e;
        }
        return {
            ok: (r.status || 200) < 400,
            status: r.status || 200,
            text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
        };
    };
}

const PROJECT_RESOLVE = { status: 200, body: { id: '0-1', shortName: 'PROJ' } };
const EMPTY_SEARCH = { status: 200, body: [] };
const CREATED = { status: 200, body: { idReadable: 'PROJ-42', summary: 'Fix login bug' } };

// ── basics ─────────────────────────────────────────────────────────────

test('isYouTrackTool covers all 12 tools and matches YOUTRACK_TOOLS defs', () => {
    const names = [
        'youtrack_search_issues', 'youtrack_get_issue', 'youtrack_create_issue',
        'youtrack_add_comment', 'youtrack_update_issue', 'youtrack_list_projects',
        'youtrack_link_issues', 'youtrack_get_issue_comments', 'youtrack_find_user',
        'youtrack_change_assignee', 'youtrack_log_work', 'youtrack_manage_tags',
    ];
    for (const n of names) assert.ok(isYouTrackTool(n), `whitelist covers ${n}`);
    assert.ok(!isYouTrackTool('youtrack_nuke_everything'));
    const defNames = YOUTRACK_TOOLS.map(t => t.function.name).sort();
    assert.deepStrictEqual(defNames, [...names].sort(), 'tool defs and whitelist agree');
});

test('normalizeSummary trims, lowercases and collapses whitespace', () => {
    assert.strictEqual(normalizeSummary('  Fix   Login\tBug  '), 'fix login bug');
    assert.strictEqual(normalizeSummary(null), '');
});

// ── create: pre-create dedup guard ─────────────────────────────────────

test('create happy path: resolve → dedup search → POST', async () => {
    scriptFetch([PROJECT_RESOLVE, EMPTY_SEARCH, CREATED]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug', description: 'details',
    }, USER);

    assert.strictEqual(fetchCalls.length, 3);
    assert.ok(fetchCalls[0].url.includes('/admin/projects/0-1'), 'first call resolves the project');
    assert.ok(fetchCalls[1].url.includes('/issues?'), 'second call is the dedup search');
    // URLSearchParams encodes spaces as '+'
    const searchQuery = decodeURIComponent(fetchCalls[1].url).replace(/\+/g, ' ');
    assert.ok(searchQuery.includes('project: {PROJ}'), 'search scoped to project');
    assert.strictEqual(fetchCalls[2].opts.method, 'POST');
    assert.deepStrictEqual(JSON.parse(fetchCalls[2].opts.body), {
        summary: 'Fix login bug', description: 'details', project: { id: '0-1' },
    });
    assert.strictEqual(res.id, 'PROJ-42');
    assert.ok(!res.error);
});

test('guard refuses create when an identical (normalized) summary exists', async () => {
    scriptFetch([
        PROJECT_RESOLVE,
        { status: 200, body: [{ idReadable: 'PROJ-9', summary: '  fix   LOGIN bug ', created: Date.now() }] },
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix Login Bug',
    }, USER);

    assert.strictEqual(fetchCalls.length, 2, 'no POST happened');
    assert.strictEqual(res.alreadyExists, true);
    assert.strictEqual(res.id, 'PROJ-9');
    assert.match(res.message, /NOT CREATED/);
    assert.match(res.message, /allowDuplicate/);
});

test('allowDuplicate: true skips the guard entirely', async () => {
    scriptFetch([CREATED]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug', allowDuplicate: true,
    }, USER);

    assert.strictEqual(fetchCalls.length, 1, 'straight POST, no resolve/search');
    assert.strictEqual(fetchCalls[0].opts.method, 'POST');
    assert.strictEqual(res.id, 'PROJ-42');
});

test('guard fails open: search error still lets the create proceed', async () => {
    scriptFetch([PROJECT_RESOLVE, { status: 500, body: { error: 'boom' } }, CREATED]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug',
    }, USER);

    assert.strictEqual(fetchCalls.length, 3);
    assert.strictEqual(res.id, 'PROJ-42');
    assert.ok(!res.error);
});

test('guard falls back to shortName when projectId is not resolvable as DB id', async () => {
    scriptFetch([
        { status: 404, body: { error: 'not found' } }, // admin lookup fails
        { status: 200, body: [{ idReadable: 'PROJ-9', summary: 'Fix login bug', created: Date.now() }] },
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: 'PROJ', summary: 'Fix login bug',
    }, USER);

    assert.strictEqual(res.alreadyExists, true, 'shortName fallback still finds the duplicate');
    assert.strictEqual(fetchCalls.length, 2);
});

// ── create: ambiguous-failure verification ─────────────────────────────

test('timeout on POST is verified by search: issue found → success, not error', async () => {
    scriptFetch([
        PROJECT_RESOLVE,
        EMPTY_SEARCH, // pre-create guard
        { throwName: 'TimeoutError' }, // POST times out — but YouTrack committed it
        { status: 200, body: [{ idReadable: 'PROJ-42', summary: 'Fix login bug', created: Date.now() }] },
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug',
    }, USER);

    assert.strictEqual(fetchCalls.length, 4);
    assert.strictEqual(res.verifiedAfterError, true);
    assert.strictEqual(res.id, 'PROJ-42');
    assert.ok(!res.error, 'no error field on verified create');
    assert.match(res.message, /Do NOT create it again/);
});

test('timeout on POST with no issue found → error with search-first guidance', async () => {
    scriptFetch([
        PROJECT_RESOLVE,
        EMPTY_SEARCH,
        { throwName: 'TimeoutError' },
        EMPTY_SEARCH, // verification search finds nothing
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug',
    }, USER);

    assert.strictEqual(fetchCalls.length, 4);
    assert.ok(res.error);
    assert.match(res.guidance, /Do NOT simply retry/);
});

test('verification ignores stale issues created before this request', async () => {
    scriptFetch([
        PROJECT_RESOLVE,
        EMPTY_SEARCH,
        { throwName: 'TimeoutError' },
        // Same summary but created 2 days ago — not from this POST.
        { status: 200, body: [{ idReadable: 'PROJ-1', summary: 'Fix login bug', created: Date.now() - 2 * 86400_000 }] },
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug',
    }, USER);

    assert.ok(res.error, 'stale match does not count as verified create');
});

test('non-ambiguous POST error (400) skips verification', async () => {
    scriptFetch([
        PROJECT_RESOLVE,
        EMPTY_SEARCH,
        { status: 400, body: { error: 'bad field' } },
    ]);
    const res = await executeYouTrackTool('youtrack_create_issue', {
        projectId: '0-1', summary: 'Fix login bug',
    }, USER);

    assert.strictEqual(fetchCalls.length, 3, 'no verification fetch after a 400');
    assert.ok(res.error);
    assert.ok(res.guidance, 'guidance still present');
});

// ── new tools ──────────────────────────────────────────────────────────

test('link_issues posts the command "duplicates <target>"', async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const res = await executeYouTrackTool('youtrack_link_issues', {
        issueId: 'NP-113', targetIssueId: 'NP-92', linkType: 'duplicates',
    }, USER);

    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.endsWith('/api/commands'));
    assert.deepStrictEqual(JSON.parse(fetchCalls[0].opts.body), {
        query: 'duplicates NP-92', issues: [{ idReadable: 'NP-113' }],
    });
    assert.strictEqual(res.linked, true);
});

test('link_issues rejects bad ids and unknown link types before any fetch', async () => {
    scriptFetch([]);
    for (const args of [
        { issueId: 'NP-113; drop', targetIssueId: 'NP-92', linkType: 'duplicates' },
        { issueId: 'NP-113', targetIssueId: 'NP-92 state Closed', linkType: 'duplicates' },
        { issueId: 'NP-113', targetIssueId: 'NP-92', linkType: 'obliterates' },
    ]) {
        const res = await executeYouTrackTool('youtrack_link_issues', args, USER);
        assert.ok(res.error, `rejected: ${JSON.stringify(args)}`);
    }
    assert.strictEqual(fetchCalls.length, 0, 'nothing reached the network');
});

test('get_issue_comments maps author and clamps limit', async () => {
    scriptFetch([{
        status: 200,
        body: [{ id: 'c1', text: 'hi', created: 1720000000000, author: { login: 'jd', fullName: 'Jane Doe' } }],
    }]);
    const res = await executeYouTrackTool('youtrack_get_issue_comments', { issueId: 'PROJ-1', limit: 999 }, USER);

    assert.ok(fetchCalls[0].url.includes('/issues/PROJ-1/comments'));
    assert.ok(fetchCalls[0].url.includes('%24top=50') || fetchCalls[0].url.includes('$top=50'), 'limit clamped to 50');
    assert.strictEqual(res.count, 1);
    assert.strictEqual(res.results[0].author, 'Jane Doe');
});

test('find_user returns login/fullName/email and points at change_assignee', async () => {
    scriptFetch([{
        status: 200,
        body: [{ id: 'u-1', login: 'jane.doe', fullName: 'Jane Doe', email: 'jane@example.com' }, { id: 'u-2', login: 'john' }],
    }]);
    const res = await executeYouTrackTool('youtrack_find_user', { query: 'jane' }, USER);

    assert.ok(fetchCalls[0].url.includes('/users?'));
    assert.strictEqual(res.count, 2);
    assert.deepStrictEqual(res.results[0], { login: 'jane.doe', fullName: 'Jane Doe', email: 'jane@example.com' });
    assert.strictEqual(res.results[1].email, null, 'missing email is null, not undefined');
    assert.match(res.message, /youtrack_change_assignee/);
});

test('change_assignee posts "for <login>" and rejects whitespace logins pre-fetch', async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const res = await executeYouTrackTool('youtrack_change_assignee', { issueId: 'PROJ-1', login: 'jane.doe' }, USER);
    assert.deepStrictEqual(JSON.parse(fetchCalls[0].opts.body), {
        query: 'for jane.doe', issues: [{ idReadable: 'PROJ-1' }],
    });
    assert.strictEqual(res.updated, true);

    scriptFetch([]);
    const bad = await executeYouTrackTool('youtrack_change_assignee', { issueId: 'PROJ-1', login: 'jane state Closed' }, USER);
    assert.ok(bad.error);
    assert.strictEqual(fetchCalls.length, 0);
});

test('log_work posts duration.minutes and maps the time-tracking-disabled error', async () => {
    scriptFetch([{ status: 200, body: {} }]);
    const res = await executeYouTrackTool('youtrack_log_work', {
        issueId: 'PROJ-1', minutes: 30, text: 'debugging', date: '2026-07-20',
    }, USER);
    assert.ok(fetchCalls[0].url.includes('/issues/PROJ-1/timeTracking/workItems'));
    const body = JSON.parse(fetchCalls[0].opts.body);
    assert.deepStrictEqual(body.duration, { minutes: 30 });
    assert.strictEqual(body.text, 'debugging');
    assert.strictEqual(body.date, Date.parse('2026-07-20T12:00:00Z'));
    assert.strictEqual(res.logged, true);

    scriptFetch([{ status: 400, body: { error_description: 'Time tracking is disabled for project' } }]);
    const disabled = await executeYouTrackTool('youtrack_log_work', { issueId: 'PROJ-1', minutes: 5 }, USER);
    assert.match(disabled.error, /Time tracking is not enabled/);

    scriptFetch([]);
    const bad = await executeYouTrackTool('youtrack_log_work', { issueId: 'PROJ-1', minutes: 0 }, USER);
    assert.ok(bad.error);
    assert.strictEqual(fetchCalls.length, 0, 'invalid minutes rejected pre-fetch');
});

test('manage_tags: add, remove, multiword braces, and injection rejection', async () => {
    scriptFetch([{ status: 200, body: {} }]);
    await executeYouTrackTool('youtrack_manage_tags', { issueId: 'PROJ-1', action: 'add', tag: 'triage' }, USER);
    assert.strictEqual(JSON.parse(fetchCalls[0].opts.body).query, 'tag triage');

    scriptFetch([{ status: 200, body: {} }]);
    await executeYouTrackTool('youtrack_manage_tags', { issueId: 'PROJ-1', action: 'remove', tag: 'Bug triage' }, USER);
    assert.strictEqual(JSON.parse(fetchCalls[0].opts.body).query, 'untag {Bug triage}');

    scriptFetch([]);
    const bad = await executeYouTrackTool('youtrack_manage_tags', { issueId: 'PROJ-1', action: 'add', tag: 'x} state Closed {' }, USER);
    assert.ok(bad.error);
    assert.strictEqual(fetchCalls.length, 0);
});

test('unconfigured user gets a setup hint, no fetch', async () => {
    scriptFetch([]);
    const res = await executeYouTrackTool('youtrack_search_issues', { query: 'x' }, 'nobody');
    assert.match(res.error, /not configured/i);
    assert.strictEqual(fetchCalls.length, 0);
});
