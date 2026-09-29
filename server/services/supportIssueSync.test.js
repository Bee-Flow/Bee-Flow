/**
 * Sync engine behaviour, with the store and the YouTrack client stubbed.
 *
 * The cases that matter are about restraint rather than throughput: a first
 * sync is not news, a resolved ticket is not flagged, an unreachable YouTrack
 * leaves the last good snapshot on screen, and nothing anywhere sends the
 * customer a message.
 */

const test = require('node:test');
const assert = require('assert');
const Module = require('module');
const { mountGated } = require('../testUtils/gatedStart');

const calls = { snapshots: [], followups: [], events: [], notifications: [], batches: [], comments: [], chat: [] };
let stubIssues = [];
let stubComments = [];
let stubCreds = { baseUrl: 'https://yt.example.com', token: 't', source: 'service' };
let snapshotResult = { changedThreadIds: [], reason: null };
let threadRows = {};

const stubStore = {
    listDistinctLinkedIssues: async () => stubIssues.map(i => i.id),
    listIssueLinks: async () => stubIssues.map(i => ({ issue_id: i.id })),
    updateLinkSnapshot: async (issueId, patch) => {
        calls.snapshots.push({ issueId, ...patch });
        return patch.syncError ? { changedThreadIds: [], reason: null } : snapshotResult;
    },
    setFollowupNeeded: async (threadId, reason) => {
        calls.followups.push({ threadId, reason });
        return threadRows[threadId] || null;
    },
    recordThreadEvent: async (e) => { calls.events.push(e); return {}; },
};

const stubClient = {
    resolveCredentials: async () => stubCreds,
    getIssuesByIds: async (_creds, ids) => {
        calls.batches.push(ids);
        return stubIssues.filter(i => ids.includes(i.id));
    },
    // Records what was asked for: the offset is the whole point (BFSF-445).
    getIssueComments: async (_creds, id, opts) => {
        calls.comments.push({ id, ...opts });
        return typeof stubComments === 'function' ? stubComments(opts) : stubComments;
    },
    issueUrl: (base, id) => `${base}/issue/${id}`,
};

const stubNotifications = {
    createNotification: async (n) => { calls.notifications.push(n); return {}; },
};

const stubChat = {
    notify: async (n) => { calls.chat.push(n); return { sent: true }; },
};

const origLoad = Module._load;
Module._load = function (request) {
    if (request.endsWith('stores/supportStore')) return stubStore;
    if (request.endsWith('integrations/youtrackClient')) return stubClient;
    if (request.endsWith('stores/notificationStore')) return stubNotifications;
    if (request.endsWith('outboundChatNotifier')) return stubChat;
    if (request.endsWith('routes/support')) throw new Error('bus not mounted');
    return origLoad.apply(this, arguments);
};
const sync = require('./supportIssueSync');
Module._load = origLoad;

function reset() {
    calls.snapshots = []; calls.followups = []; calls.events = [];
    calls.notifications = []; calls.batches = []; calls.comments = []; calls.chat = [];
    stubIssues = []; stubComments = [];
    snapshotResult = { changedThreadIds: [], reason: null };
    threadRows = {};
    stubCreds = { baseUrl: 'https://yt.example.com', token: 't', source: 'service' };
}

test('one batched request covers every linked issue, not one per issue', async () => {
    reset();
    stubIssues = Array.from({ length: 30 }, (_, n) => ({ id: `BFSF-${100 + n}`, summary: 's', state: 'Open' }));
    const r = await sync.syncTick();
    assert.strictEqual(calls.batches.length, 1, 'thirty issues must not cost thirty requests');
    assert.strictEqual(calls.batches[0].length, 30);
    assert.strictEqual(r.issues, 30);
});

test('a moved issue flags every ticket linked to it', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Fixed', resolved: true }];
    snapshotResult = { changedThreadIds: ['t1', 't2', 't3'], reason: 'state' };
    threadRows = {
        t1: { id: 't1', ticket_ref: 'BF-1', assignee_user_id: 'agent_a' },
        t2: { id: 't2', ticket_ref: 'BF-2', assignee_user_id: null },
        t3: { id: 't3', ticket_ref: 'BF-3', assignee_user_id: 'agent_b' },
    };

    const r = await sync.syncTick();
    assert.strictEqual(r.flagged, 3, 'one issue, three customers waiting, three flags');
    assert.deepStrictEqual(calls.followups.map(f => f.threadId), ['t1', 't2', 't3']);
    assert.match(calls.followups[0].reason, /BFSF-441 is now Fixed/);

    // Assigned tickets get a bell; unassigned ones just carry the flag.
    assert.deepStrictEqual(calls.notifications.map(n => n.userId), ['agent_a', 'agent_b']);
    assert.deepStrictEqual(calls.events.map(e => e.action), ['issue_update', 'issue_update', 'issue_update']);
});

test('a resolved or closed ticket is not dragged back open', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Fixed' }];
    snapshotResult = { changedThreadIds: ['open_one', 'closed_one'], reason: 'comment' };
    // The store refuses resolved/closed tickets by returning null.
    threadRows = { open_one: { id: 'open_one', ticket_ref: 'BF-9', assignee_user_id: null } };

    const r = await sync.syncTick();
    assert.strictEqual(r.flagged, 1);
    assert.deepStrictEqual(calls.events.map(e => e.threadId), ['open_one']);
});

test('nothing changed means nothing is flagged and nobody is notified', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open' }];
    snapshotResult = { changedThreadIds: [], reason: null };
    const r = await sync.syncTick();
    assert.strictEqual(r.flagged, 0);
    assert.strictEqual(calls.followups.length, 0);
    assert.strictEqual(calls.notifications.length, 0);
});

test('an unreachable YouTrack records the error and keeps the last good snapshot', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441' }, { id: 'BFSF-442' }];
    stubClient.getIssuesByIds = async () => { throw new Error('connect ETIMEDOUT'); };

    const r = await sync.syncTick();
    assert.strictEqual(r.flagged, 0);
    // Only sync_error is written — no state, no summary, so the view still has
    // something true to show beside "couldn't reach YouTrack".
    assert.strictEqual(calls.snapshots.length, 2);
    for (const s of calls.snapshots) {
        assert.match(s.syncError, /ETIMEDOUT/);
        assert.strictEqual(s.state, undefined);
        assert.strictEqual(s.summary, undefined);
    }
    stubClient.getIssuesByIds = async (_c, ids) => { calls.batches.push(ids); return stubIssues.filter(i => ids.includes(i.id)); };
});

test('an issue the search does not return is marked, not left looking healthy', async () => {
    reset();
    // Linked to two, YouTrack returns one: the other was deleted or is hidden
    // from the service account.
    stubIssues = [{ id: 'BFSF-441', summary: 'here', state: 'Open' }];
    stubStore.listDistinctLinkedIssues = async () => ['BFSF-441', 'BFSF-999'];

    await sync.syncTick();
    const missing = calls.snapshots.find(s => s.issueId === 'BFSF-999');
    assert.ok(missing, 'the missing issue must get a row update');
    assert.match(missing.syncError, /not found in YouTrack/);

    stubStore.listDistinctLinkedIssues = async () => stubIssues.map(i => i.id);
});

test('the poller refuses to borrow an agent\'s personal token', async () => {
    reset();
    let askedServiceOnly = null;
    stubClient.resolveCredentials = async (opts) => { askedServiceOnly = opts?.serviceOnly; return null; };

    const r = await sync.syncTick();
    assert.strictEqual(askedServiceOnly, true);
    assert.deepStrictEqual(r, { skipped: 'no service connection' });

    stubClient.resolveCredentials = async () => stubCreds;
});

test('BFSF-438: the poller goes through the support module gate', async () => {
    reset();
    let credReads = 0;
    stubClient.resolveCredentials = async () => { credReads += 1; return stubCreds; };
    const w = mountGated((opts) => sync.start(opts), { intervalMs: 1000 });
    try {
        assert.deepStrictEqual(w.state.consulted.map(c => [c.moduleId, c.fn]), [['support', sync.syncTick]]);
        assert.strictEqual(w.timers.length, 1);

        // Support removed in the Modules panel: YouTrack is not polled.
        w.state.active = false;
        await w.fireAll();
        assert.strictEqual(credReads, 0, 'a removed Support module still polled YouTrack');

        w.state.active = true;
        await w.fireAll();
        assert.strictEqual(credReads, 1, 'the gated tick no longer reaches the sync');
    } finally {
        sync.stop();
        stubClient.resolveCredentials = async () => stubCreds;
    }
});

// ── The newest comment, not the first (BFSF-445) ─────────────────────────
// YouTrack lists comments oldest first. `$top=1` on its own read the first
// comment ever made, and the ticket showed it as the latest.

const C1 = { id: 'c1', text: 'first', author: 'Dev A', created: '2026-01-01T10:00:00.000Z' };
const C2 = { id: 'c2', text: 'second', author: 'Dev B', created: '2026-01-02T10:00:00.000Z' };
const C3 = { id: 'c3', text: 'third', author: 'Dev A', created: '2026-01-03T10:00:00.000Z' };

test('the snapshot carries the newest comment: skip to the end, read one', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 3 }];
    stubComments = (opts) => (opts.skip === 2 ? [C3] : [C1]);

    await sync.syncTick();
    assert.deepStrictEqual(calls.comments, [{ id: 'BFSF-441', skip: 2, limit: 1 }]);
    assert.strictEqual(calls.snapshots[0].lastCommentText, 'third');
    assert.strictEqual(calls.snapshots[0].lastCommentAt, C3.created);
});

test('an issue without comments costs no comment request', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 0 }];
    await sync.syncTick();
    assert.strictEqual(calls.comments.length, 0);
    assert.strictEqual(calls.snapshots[0].lastCommentAt, null);
});

test('without a count, a window is read and the newest is picked by date', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open' }];
    stubComments = [C2, C3, C1];
    await sync.syncTick();
    assert.strictEqual(calls.comments[0].limit, 50);
    assert.strictEqual(calls.snapshots[0].lastCommentText, 'third');
});

test('an offset past the end falls back to the tail of the thread', async () => {
    reset();
    // Counted but not visible to this connection: the offset reads nothing.
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 4 }];
    stubComments = (opts) => (opts.skip === 3 ? [] : [C1, C2, C3]);
    await sync.syncTick();
    assert.deepStrictEqual(calls.comments.map(c => [c.skip, c.limit]), [[3, 1], [0, 50]]);
    assert.strictEqual(calls.snapshots[0].lastCommentText, 'third');
});

// ── Baselines, so old comments are not news (BFSF-446) ───────────────────

test('a failed comment read tells the store to keep what it has', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 2 }];
    stubComments = () => { throw new Error('HTTP 503'); };
    await sync.syncTick();
    assert.strictEqual(calls.snapshots[0].commentFetched, false);
    assert.strictEqual(calls.snapshots[0].state, 'Open', 'the state still updates');

    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 1 }];
    stubComments = [C1];
    await sync.syncTick();
    assert.strictEqual(calls.snapshots[0].commentFetched, true);
});

test('linking takes the same baseline a tick would: state label and newest comment', async () => {
    reset();
    stubComments = (opts) => (opts.skip === 1 ? [C2] : [C1]);
    const b = await sync.linkBaseline(stubCreds, { id: 'BFSF-441', summary: 'Bug', state: null, resolved: true, commentsCount: 2 });
    assert.deepStrictEqual(b, {
        issueSummary: 'Bug',
        // An issue without a State field reads as 'Resolved' in the tick, so
        // the link must store the same, or the first tick sees a "change".
        issueState: 'Resolved',
        issueResolved: true,
        lastCommentText: 'second',
        lastCommentAuthor: 'Dev B',
        lastCommentAt: C2.created,
        commentsSeeded: true,
    });
});

test('a link whose comments could not be read is left for the first tick to seed', async () => {
    reset();
    stubComments = () => { throw new Error('HTTP 503'); };
    const b = await sync.linkBaseline(stubCreds, { id: 'BFSF-441', summary: 'Bug', state: 'Open', commentsCount: 3 });
    assert.strictEqual(b.commentsSeeded, false);
    assert.strictEqual(b.issueState, 'Open');

    // No connection, so no issue read at all.
    assert.strictEqual((await sync.linkBaseline(null, null)).commentsSeeded, false);
});

// ── issue_resolved reaches the team channel (BFSF-448) ───────────────────

test('a resolved issue tells the chat channel about each ticket that was flagged', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'Fixed', resolved: true, commentsCount: 0 }];
    snapshotResult = { changedThreadIds: ['open_one', 'closed_one'], resolvedThreadIds: ['open_one', 'closed_one'], reason: 'state' };
    threadRows = { open_one: { id: 'open_one', ticket_ref: 'BF-9', assignee_user_id: null } };

    await sync.syncTick();
    // The closed ticket was not flagged, so it is not news in chat either.
    assert.strictEqual(calls.chat.length, 1);
    assert.strictEqual(calls.chat[0].event, 'issue_resolved');
    assert.strictEqual(calls.chat[0].thread, threadRows.open_one);
    assert.strictEqual(calls.chat[0].detail, 'BFSF-441 is now Fixed');
});

test('a state move that is not a resolution sends nothing to chat', async () => {
    reset();
    stubIssues = [{ id: 'BFSF-441', summary: 'Bug', state: 'In Progress', commentsCount: 0 }];
    snapshotResult = { changedThreadIds: ['t1'], resolvedThreadIds: [], reason: 'state' };
    threadRows = { t1: { id: 't1', ticket_ref: 'BF-1', assignee_user_id: null } };

    await sync.syncTick();
    assert.strictEqual(calls.followups.length, 1);
    assert.strictEqual(calls.chat.length, 0);
});
