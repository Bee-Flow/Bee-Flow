/**
 * transcriptionStore — the SQL added for meeting insights, run on a real
 * Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js) with the
 * store's own schema.
 *
 * These are the mechanically riskiest edits of the feature: a hand-numbered
 * many-column INSERT, a conditional tags UPDATE, and a hand-built ACL query for
 * the recurring-series card. Every value is read back from the row it landed in.
 *
 * Run: cd server && node --test stores/transcriptionStore.insights.test.js
 */

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');
before(() => store.initDB());
after(close);
beforeEach(async () => { await pg.exec('DELETE FROM transcriptions'); });

/** @param {string} id @param {Record<string, unknown>} [over] */
const note = (id, over = {}) => insertRow(pg, 'transcriptions', { id, user_id: 'u1', title: id, ...over });
/** @param {string} id */
const row = async (id) => (await pg.query('SELECT * FROM transcriptions WHERE id = $1', [id])).rows[0];

test('createTranscription: every column lands with its own value', async () => {
    const created = await store.createTranscription({
        userId: 'u1', title: 'T', fileName: 'a.mp3',
        actionItems: [{ id: 'ai-0' }],
        decisions: [{ id: 'd-0', text: 'Besluit' }],
        questions: [{ id: 'q-0', text: 'Vraag', open: true }],
        tags: ['planning'],
    });
    const r = await row(created.id);
    assert.deepStrictEqual(
        [r.user_id, r.title, r.file_name, r.decisions, r.questions, r.tags, r.action_items],
        ['u1', 'T', 'a.mp3', [{ id: 'd-0', text: 'Besluit' }], [{ id: 'q-0', text: 'Vraag', open: true }], ['planning'], [{ id: 'ai-0' }]],
    );
});

test('createTranscription: omitted artifacts default to empty JSON arrays', async () => {
    const created = await store.createTranscription({ userId: 'u1', title: 'T', fileName: 'a.mp3' });
    const r = await row(created.id);
    for (const col of ['decisions', 'questions', 'tags']) assert.deepStrictEqual(r[col], [], `${col} defaults to []`);
});

test('updateTranscription: each artifact column gets its OWN value, owner-scoped', async () => {
    await note('t-1');
    await note('t-other', { user_id: 'u2' });
    await store.updateTranscription('t-1', 'u1', {
        summary: 'S',
        actionItems: [{ id: 'ai-0', text: 'C' }],
        decisions: [{ id: 'd-0', text: 'A' }],
        questions: [{ id: 'q-0', text: 'B', open: false }],
    });
    const r = await row('t-1');
    assert.deepStrictEqual(r.action_items.map(({ id, text }) => ({ id, text })), [{ id: 'ai-0', text: 'C' }]);
    assert.deepStrictEqual(r.decisions.map(({ id, text }) => ({ id, text })), [{ id: 'd-0', text: 'A' }]);
    assert.deepStrictEqual(r.questions.map(({ id, text, open }) => ({ id, text, open })), [{ id: 'q-0', text: 'B', open: false }]);
    assert.strictEqual(await store.updateTranscription('t-other', 'u1', { decisions: [{ id: 'x', text: 'not mine' }] }), false);
    assert.deepStrictEqual((await row('t-other')).decisions, [], 'someone else\'s note is untouched');
});

test('updateTranscription: `artifactsSince` is ÉÉN vertrekpunt voor alle drie de kolommen', async () => {
    // Eén vertrekpunt, uit één read — drie kolommen die er los van elkaar op
    // vergelijken zouden aan de randen van het venster uit elkaar lopen.
    await note('t-1');
    await store.updateTranscription('t-1', 'u1', {
        actionItems: [{ id: 'ai-0', text: 'C' }],
        decisions: [{ id: 'd-0', text: 'A' }],
        questions: [{ id: 'q-0', text: 'B', open: false }],
        artifactsSince: '2026-07-01T09:00:00.000Z',
    });
    const r = await row('t-1');
    assert.deepStrictEqual([r.action_items.length, r.decisions.length, r.questions.length], [1, 1, 1],
        'all three columns written from the same window');
});

test('updateTranscription: tagsIfEmpty only fills an empty column, tags overwrites', async () => {
    await note('empty', { tags: [] });
    await note('null-tags', { tags: null });
    await note('tagged', { tags: ['mine'] });
    for (const id of ['empty', 'null-tags', 'tagged']) await store.updateTranscription(id, 'u1', { tagsIfEmpty: ['auto'] });
    // The guard is what stops auto-tags from clobbering user tags.
    assert.deepStrictEqual((await row('empty')).tags, ['auto']);
    assert.deepStrictEqual((await row('null-tags')).tags, ['auto']);
    assert.deepStrictEqual((await row('tagged')).tags, ['mine']);
    await store.updateTranscription('tagged', 'u1', { tags: ['manual'] });
    assert.deepStrictEqual((await row('tagged')).tags, ['manual'], 'the explicit tags update is unconditional');
});

test('getTranscription: decisions/questions are parsed from JSONB text or objects', async () => {
    await note('t-1', {
        decisions: JSON.stringify(JSON.stringify([{ id: 'd-0', text: 'Besluit' }])),   // a JSON string holding the array
        questions: [{ id: 'q-0', text: 'Vraag', open: true }],
    });
    const n = await store.getTranscription('t-1', 'u1', { isSuperAdmin: true });
    assert.deepStrictEqual(n.decisions, [{ id: 'd-0', text: 'Besluit' }]);
    assert.deepStrictEqual(n.questions, [{ id: 'q-0', text: 'Vraag', open: true }]);
});

test('getTranscription: a note with the artifact columns NULL reads as empty lists', async () => {
    await note('t-1', { decisions: null, questions: null });
    const n = await store.getTranscription('t-1', 'u1', { isSuperAdmin: true });
    assert.deepStrictEqual(n.decisions, []);
    assert.deepStrictEqual(n.questions, []);
});

const BRANCHES = [{ isSuperAdmin: true }, { orgIds: ['org-1'], userGroupIds: ['g1'] }];

test('getTranscriptions: the list payload carries tags on BOTH query branches', async () => {
    // The library's tag chips and filters read `tags` off list rows.
    await note('t-1', { tags: ['planning'] });
    for (const opts of BRANCHES) {
        const [r] = await store.getTranscriptions('u1', opts);
        assert.deepStrictEqual(r.tags, ['planning'], `tags for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: a summary PREFIX travels on both branches, never the whole summary', async () => {
    // A library of 50 notes would otherwise ship 50 full summaries to draw five
    // menu rows.
    const summary = '## Samenvatting\n\nWe spraken over Azure.';
    await note('t-1', { summary: summary + ' '.repeat(10) + 'x'.repeat(2000) });
    for (const opts of BRANCHES) {
        const [r] = await store.getTranscriptions('u1', opts);
        assert.ok(r.summarySnippet.startsWith(summary), `summary prefix for ${JSON.stringify(opts)}`);
        assert.ok(r.summarySnippet.length <= 400, 'a prefix, not the column');
        assert.ok(!('summary' in r) || r.summary === undefined, `full summary must not travel for ${JSON.stringify(opts)}`);
    }
});

test('getTranscriptions: a note with no summary yet reports an empty snippet, not undefined', async () => {
    // Processing notes have summary = '' — the row must still carry the key so
    // the client can tell "no summary" from "this payload predates the field".
    await note('t-1', { summary: '' });
    const [r] = await store.getTranscriptions('u1', { isSuperAdmin: true });
    assert.strictEqual(r.summarySnippet, '');
});

const SERIES = { meetMeetingCode: 'abc-defg-hij', beforeCreatedAt: '2026-07-08T09:00:00.000Z', excludeId: 't-now' };

test('getSeriesPrevious: the newest earlier completed note of the series, with only its open action items', async () => {
    const items = [{ id: 'ai-0', text: 'Open taak', done: false }, { id: 'ai-1', text: 'Klaar', done: true }];
    await note('prev', { meet_meeting_code: SERIES.meetMeetingCode, status: 'completed', created_at: '2026-07-01T09:00:00Z', summary: 'S', action_items: items });
    await note('older', { meet_meeting_code: SERIES.meetMeetingCode, status: 'completed', created_at: '2026-06-01T09:00:00Z' });
    await note('failed', { meet_meeting_code: SERIES.meetMeetingCode, status: 'failed', created_at: '2026-07-05T09:00:00Z' });
    await note('later', { meet_meeting_code: SERIES.meetMeetingCode, status: 'completed', created_at: '2026-07-09T09:00:00Z' });
    await note('t-now', { meet_meeting_code: SERIES.meetMeetingCode, status: 'completed', created_at: '2026-07-07T09:00:00Z' });
    await note('other-series', { meet_meeting_code: 'zzz', status: 'completed', created_at: '2026-07-06T09:00:00Z' });
    const prev = await store.getSeriesPrevious({ ...SERIES, userId: 'u1', orgIds: ['org-1'], userGroupIds: ['g1'] });
    assert.strictEqual(prev.id, 'prev');
    assert.deepStrictEqual(prev.openActionItems, [{ id: 'ai-0', text: 'Open taak', done: false }]);
    assert.strictEqual(prev.createdAt, '2026-07-01T09:00:00.000Z');
    assert.strictEqual(prev.summary, 'S');
});

test('getSeriesPrevious: ACL parity with getTranscription — owner, legacy share, org-published (group-scoped)', async () => {
    const base = { meet_meeting_code: SERIES.meetMeetingCode, status: 'completed', user_id: 'u2' };
    const pick = (/** @type {any} */ opts) => store.getSeriesPrevious({ ...SERIES, userId: 'u1', ...opts }).then((p) => p?.id ?? null);
    await note('theirs', { ...base, created_at: '2026-07-01T00:00:00Z' });
    assert.strictEqual(await pick({ orgIds: ['org-1'] }), null, 'someone else\'s private note');
    await note('grp-other', { ...base, is_published: true, organization_id: 'org-1', shared_groups: ['g9'], created_at: '2026-07-02T00:00:00Z' });
    assert.strictEqual(await pick({ orgIds: ['org-1'], userGroupIds: ['g1'] }), null, 'published to another group');
    await note('grp-mine', { ...base, is_published: true, organization_id: 'org-1', shared_groups: ['g1'], created_at: '2026-07-03T00:00:00Z' });
    assert.strictEqual(await pick({ orgIds: ['org-1'], userGroupIds: ['g1'] }), 'grp-mine');
    assert.strictEqual(await pick({ orgIds: ['org-1'] }), null, 'without groups only org-wide notes count');
    await note('org-wide', { ...base, is_published: true, organization_id: 'org-1', created_at: '2026-07-04T00:00:00Z' });
    assert.strictEqual(await pick({ orgIds: ['org-1'] }), 'org-wide');
    assert.strictEqual(await pick({ orgIds: ['org-2'] }), null, 'another org');
    await note('shared', { ...base, shared_with: ['u1'], created_at: '2026-07-05T00:00:00Z' });
    assert.strictEqual(await pick({}), 'shared', 'a legacy share, and no orgIds means no org clause');
    await note('own', { ...base, user_id: 'u1', created_at: '2026-07-06T00:00:00Z' });
    assert.strictEqual(await pick({}), 'own');
    await note('admin-sees', { ...base, user_id: 'u9', created_at: '2026-07-07T00:00:00Z' });
    assert.strictEqual(await pick({ isSuperAdmin: true }), 'admin-sees', 'super admin bypasses the ACL clause');
});

test('getSeriesPrevious: talk rooms, and no-series notes', async () => {
    await note('room-prev', { talk_room_token: 'tok123', status: 'completed', created_at: '2026-07-01T00:00:00Z' });
    await note('room-other', { talk_room_token: 'tok999', status: 'completed', created_at: '2026-07-02T00:00:00Z' });
    const p = await store.getSeriesPrevious({ talkRoomToken: 'tok123', beforeCreatedAt: '2026-07-08T00:00:00Z', excludeId: 't', userId: 'u1' });
    assert.strictEqual(p.id, 'room-prev');
    // A note with no series link answers null.
    assert.strictEqual(await store.getSeriesPrevious({ beforeCreatedAt: '2026-07-08T00:00:00Z', excludeId: 't', userId: 'u1' }), null);
});
