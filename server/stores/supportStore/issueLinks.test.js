/**
 * Issue-link snapshots and the follow-up diff, against a REAL Postgres
 * (@electric-sql/pglite, in-process) and the store's real schema.
 *
 * BFSF-446: the follow-up flag is meant to mean "a linked issue changed state
 * or a developer wrote something new". It was raised for the wrong things:
 *
 *   A. Attaching an existing issue stored its state but no comment, so the
 *      first sync saw "no comment before, one now" and flagged a follow-up
 *      for a comment that could be weeks old.
 *   B. The diff ran over every link of the issue at once, so attaching it to
 *      a second ticket flagged the first ticket too.
 *   C. The poller read the OLDEST comment (BFSF-445), so later comments never
 *      moved the snapshot and never raised anything.
 *   D. Fixing C alone makes the first tick flag every existing link whose
 *      issue has more than one comment: the stored "latest" is the oldest.
 *
 * The cure is per-link: a comment is news only on a link that already has a
 * comment baseline (`comments_seeded`), and linking takes that baseline.
 *
 * Run: cd server && node --test stores/supportStore/issueLinks.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { PGlite } = require('@electric-sql/pglite');
const { installResolveStub } = require('../../testUtils/stubRequire');

const pg = new PGlite();

async function query(sql, params) {
    const res = Array.isArray(params) && params.length > 0
        ? await pg.query(sql, params)
        : (/;\s*\S/.test(String(sql).trim()) ? (await pg.exec(sql)).at(-1) : await pg.query(sql));
    const rows = res?.rows || [];
    return { rows, rowCount: res?.fields?.length ? rows.length : (res?.affectedRows ?? 0) };
}

const restoreStubs = installResolveStub({ '../../db': { pool: { query } } });
const links = require('./issueLinks');

const ISSUE = 'BFSF-900';
const T1 = '2026-01-01T09:00:00.000Z';
const T2 = '2026-01-02T09:00:00.000Z';
const T3 = '2026-01-03T09:00:00.000Z';
const T4 = '2026-01-04T09:00:00.000Z';

let threadA;
let threadB;

async function newThread() {
    const { rows } = await query(
        `INSERT INTO support_threads (requester_email, source, subject)
         VALUES ($1, 'in_app', 'Synthetic subject') RETURNING id`,
        ['requester@example.test'],
    );
    return rows[0].id;
}

/** What a sync tick hands the store for ISSUE. */
function snapshot({ state = 'Open', resolved = false, at = null, text = 'a comment', fetched = true } = {}) {
    return links.updateLinkSnapshot(ISSUE, {
        summary: 'Synthetic issue', state, resolved, url: null,
        lastCommentText: at ? text : null, lastCommentAuthor: at ? 'Developer' : null,
        lastCommentAt: at, commentFetched: fetched,
    });
}

/** The follow-up part of a tick's answer. */
async function tick(opts) {
    const { changedThreadIds, reason } = await snapshot(opts);
    return { changedThreadIds, reason };
}

async function linkRow(threadId) {
    const { rows } = await query(
        'SELECT * FROM support_issue_links WHERE thread_id = $1 AND issue_id = $2', [threadId, ISSUE]);
    return rows[0];
}

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    // Creates the real schema through the store's own init.
    await links.listDistinctLinkedIssues();
});

beforeEach(async () => {
    await query('DELETE FROM support_issue_links');
    await query('DELETE FROM support_threads');
    threadA = await newThread();
    threadB = await newThread();
});

after(async () => {
    restoreStubs();
    await pg.close();
});

test('A: attaching an issue with an old comment, then a tick, flags nothing', async () => {
    // What the attach route writes: the state and latest comment as they are.
    await links.linkIssue({
        threadId: threadA, issueId: ISSUE, issueSummary: 'Synthetic issue', issueState: 'Open',
        lastCommentText: 'old', lastCommentAuthor: 'Developer', lastCommentAt: T1, commentsSeeded: true,
    });
    assert.deepStrictEqual(await tick({ at: T1 }), { changedThreadIds: [], reason: null });
});

test('A (unseeded link): the first tick takes the baseline quietly, the next comment is news', async () => {
    // A link made without a readable issue (no connection, or the comment
    // read failed) carries no baseline.
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open' });

    assert.deepStrictEqual(await tick({ at: T1 }), { changedThreadIds: [], reason: null });
    const row = await linkRow(threadA);
    assert.strictEqual(row.comments_seeded, true);
    assert.strictEqual(new Date(row.last_comment_at).toISOString(), T1);

    assert.deepStrictEqual(await tick({ at: T2 }), { changedThreadIds: [threadA], reason: 'comment' });
});

test('B: linking the issue to a second ticket does not flag the first', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', lastCommentAt: T1, commentsSeeded: true });
    await tick({ at: T1 });

    await links.linkIssue({ threadId: threadB, issueId: ISSUE, issueState: 'Open', lastCommentAt: T1, commentsSeeded: true });
    assert.deepStrictEqual(await tick({ at: T1 }), { changedThreadIds: [], reason: null });
});

test('B: a comment one ticket already saw at link time is news only to the other', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', lastCommentAt: T1, commentsSeeded: true });
    // T2 lands, and ticket B is linked before the next tick: B's baseline is T2.
    await links.linkIssue({ threadId: threadB, issueId: ISSUE, issueState: 'Open', lastCommentAt: T2, commentsSeeded: true });

    assert.deepStrictEqual(await tick({ at: T2 }), { changedThreadIds: [threadA], reason: 'comment' });
});

test('C: every newer comment on a seeded link raises a follow-up, not just the first', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', lastCommentAt: T1, commentsSeeded: true });
    assert.deepStrictEqual(await tick({ at: T2 }), { changedThreadIds: [threadA], reason: 'comment' });
    assert.deepStrictEqual(await tick({ at: T2 }), { changedThreadIds: [], reason: null });
    assert.deepStrictEqual(await tick({ at: T3 }), { changedThreadIds: [threadA], reason: 'comment' });
});

test('D: links from before the baseline existed do not burst on the first tick', async () => {
    // As the old code left them: state set, the OLDEST comment stored, no seed flag.
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open' });
    await links.linkIssue({ threadId: threadB, issueId: ISSUE, issueState: 'Open' });
    await query('UPDATE support_issue_links SET last_comment_at = $1, comments_seeded = false', [T1]);

    assert.deepStrictEqual(await tick({ at: T3 }), { changedThreadIds: [], reason: null });
    const res = await tick({ at: T4 });
    assert.deepStrictEqual(res.changedThreadIds.sort(), [threadA, threadB].sort());
    assert.strictEqual(res.reason, 'comment');
});

test('the first comment on a new issue is news', async () => {
    // What the create route writes: a new issue, no comments, a known baseline.
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueSummary: 'Synthetic issue', commentsSeeded: true });
    await tick({ state: 'Submitted' });
    assert.deepStrictEqual(await tick({ state: 'Submitted', at: T1 }), { changedThreadIds: [threadA], reason: 'comment' });
});

test('a state change is news; a first state is not', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, commentsSeeded: true });
    assert.deepStrictEqual(await tick({ state: 'Open' }), { changedThreadIds: [], reason: null });
    assert.deepStrictEqual(await tick({ state: 'Fixed' }), { changedThreadIds: [threadA], reason: 'state' });
    assert.deepStrictEqual(await tick({ state: 'Verified', at: T1 }), { changedThreadIds: [threadA], reason: 'both' });
});

test('an issue going resolved is reported per link, once (BFSF-448 issue_resolved)', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', commentsSeeded: true });

    const res = await snapshot({ state: 'Fixed', resolved: true });
    assert.deepStrictEqual(res.changedThreadIds, [threadA]);
    assert.deepStrictEqual(res.resolvedThreadIds, [threadA]);
    assert.strictEqual(res.reason, 'state');

    // Still resolved on the next tick: no longer news.
    assert.deepStrictEqual((await snapshot({ state: 'Fixed', resolved: true })).resolvedThreadIds, []);
});

test('an issue without a State field going resolved is still reported', async () => {
    // Linked with the issue read: no State field, so no state label until it
    // resolves, but the link has its baseline.
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: null, commentsSeeded: true });
    assert.deepStrictEqual(await snapshot({ state: null }), { changedThreadIds: [], resolvedThreadIds: [], reason: null });

    const res = await snapshot({ state: 'Resolved', resolved: true });
    assert.deepStrictEqual(res, { changedThreadIds: [threadA], resolvedThreadIds: [threadA], reason: 'state' });
});

test('linking an issue that is already resolved is not a resolution', async () => {
    // Linked without a readable issue: no state, so the first sync is not news.
    await links.linkIssue({ threadId: threadA, issueId: ISSUE });
    // Linked with the issue read: resolved already at link time.
    await links.linkIssue({ threadId: threadB, issueId: ISSUE, issueState: 'Fixed', issueResolved: true, commentsSeeded: true });

    const res = await snapshot({ state: 'Fixed', resolved: true });
    assert.deepStrictEqual(res, { changedThreadIds: [], resolvedThreadIds: [], reason: null });
});

test('a failed comment read keeps the stored comment and raises nothing', async () => {
    await links.linkIssue({
        threadId: threadA, issueId: ISSUE, issueState: 'Open',
        lastCommentText: 'kept', lastCommentAuthor: 'Developer', lastCommentAt: T1, commentsSeeded: true,
    });
    assert.deepStrictEqual(await tick({ fetched: false }), { changedThreadIds: [], reason: null });

    const row = await linkRow(threadA);
    assert.strictEqual(row.last_comment_text, 'kept');
    assert.strictEqual(new Date(row.last_comment_at).toISOString(), T1);
    // Blanking it would have made the same comment "new" on the next tick.
    assert.deepStrictEqual(await tick({ at: T1 }), { changedThreadIds: [], reason: null });
});

test('a sync error leaves the snapshot alone', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', lastCommentAt: T1, commentsSeeded: true });
    await links.updateLinkSnapshot(ISSUE, { syncError: 'connect ETIMEDOUT' });
    const row = await linkRow(threadA);
    assert.strictEqual(row.issue_state, 'Open');
    assert.strictEqual(row.sync_error, 'connect ETIMEDOUT');
});

test('re-linking keeps the existing baseline', async () => {
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, issueState: 'Open', lastCommentAt: T2, commentsSeeded: true });
    await links.linkIssue({ threadId: threadA, issueId: ISSUE, linkReason: 'again' });
    const row = await linkRow(threadA);
    assert.strictEqual(row.comments_seeded, true);
    assert.strictEqual(new Date(row.last_comment_at).toISOString(), T2);
    assert.strictEqual(row.link_reason, 'again');
});
