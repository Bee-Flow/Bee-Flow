/**
 * "After every meeting" — the tap that makes it mean what it says.
 *
 * A `meeting_tag` knowledge source in `after_meeting` mode is supposed to pick
 * a note up as soon as it is written. Without this tap it would wait for its
 * next scheduled pass, so a decision taken this morning would be searchable
 * tomorrow — and the mode would be a label with nothing behind it.
 *
 * ── ARM, DO NOT REFRESH ─────────────────────────────────────────────
 * The two properties worth protecting are both about what this DOESN'T do:
 * it does not run the pass inline (the caller is an ingest whose note is
 * already saved, and ten meetings ending together would be ten concurrent
 * embedding passes), and it does not override a mode somebody chose.
 *
 * Run: cd server && node --test --test-force-exit jobs/kbSourceRefresh.meetingTap.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const kbSourceRefresh = require('./kbSourceRefresh');
const { onMeetingProcessed } = kbSourceRefresh;
const { installResolveStub, evictModule } = require('../testUtils/stubRequire');

function store(over = {}) {
    const calls = [];
    return {
        calls,
        armMeetingSources: async (tags) => { calls.push(tags); return over.armed ?? 1; },
        ...(over.throws ? { armMeetingSources: async () => { throw new Error(over.throws); } } : {}),
    };
}

test('a finished meeting arms the sources watching its tags', async () => {
    const s = store();
    const armed = await onMeetingProcessed({ transcriptionId: 'm1', tags: ['sales', 'klant-van-dijk'] }, { store: s });
    assert.strictEqual(armed, 1);
    assert.deepStrictEqual(s.calls, [['sales', 'klant-van-dijk']]);
});

test('an untagged meeting arms nothing, and asks nothing', async () => {
    // Every meeting_tag source is keyed on a tag; a note with none matches no
    // source, and a query to discover that is a query for nothing.
    const s = store();
    for (const payload of [{ tags: [] }, {}, { tags: null }, null]) {
        assert.strictEqual(await onMeetingProcessed(payload, { store: s }), 0, JSON.stringify(payload));
    }
    assert.deepStrictEqual(s.calls, []);
});

test('it returns immediately — no pass is run inline', async () => {
    // The caller is a meeting ingest whose note is already saved. The refresh
    // job has the lock, the concurrency limit and the time budget; this has
    // none of them, and running a pass here would bypass all three.
    let refreshed = false;
    const sources = require('../core/kb/sources');
    const realSync = sources.syncSource;
    sources.syncSource = async () => { refreshed = true; return {}; };
    try {
        await onMeetingProcessed({ tags: ['sales'] }, { store: store() });
        assert.strictEqual(refreshed, false, 'arming is a column write, not a refresh');
    } finally {
        sources.syncSource = realSync;
    }
});

test('a store that fails costs the promptness, never the meeting', async () => {
    // The note is saved by the time this runs, and the source still refreshes
    // on its own schedule.
    const s = store({ throws: 'kb_sources is locked' });
    await assert.doesNotReject(() => onMeetingProcessed({ tags: ['sales'] }, { store: s }));
    assert.strictEqual(await onMeetingProcessed({ tags: ['sales'] }, { store: s }), 0);
});

test('the bus tap is wired, or none of this ever runs', async () => {
    // The tap lives beside talkAutoIngest in triggerBus/dispatch. Without the
    // wiring the event fires into subscriptions only and no source is armed.
    // Called for real: stub the subscription lookup (irrelevant here) and spy
    // on this module's own export the way dispatch.js reaches it — at call
    // time, via require('../../jobs/kbSourceRefresh') — instead of reading
    // dispatch.js as text.
    const restoreStub = installResolveStub({
        '../../stores/automationStore': { getSubscriptionsForProvider: async () => [] },
    });
    const realOnMeetingProcessed = kbSourceRefresh.onMeetingProcessed;
    const calls = [];
    kbSourceRefresh.onMeetingProcessed = (payload) => { calls.push(payload); return 0; };
    evictModule(require.resolve('../automation/triggerBus/dispatch'));
    try {
        const { dispatchEvent } = require('../automation/triggerBus/dispatch');
        // userId AND orgId: bypasses every fail-closed scope guard regardless
        // of how 'meeting-notes' is classified, so only the wiring is on test.
        await dispatchEvent({
            provider: 'meeting-notes', event: 'meeting.processed',
            payload: { tags: ['sales'] }, userId: 'u1', orgId: 'org1',
        });
        assert.deepStrictEqual(calls, [{ tags: ['sales'] }],
            'dispatchEvent must call onMeetingProcessed for meeting-notes.meeting.processed');
    } finally {
        kbSourceRefresh.onMeetingProcessed = realOnMeetingProcessed;
        restoreStub();
        evictModule(require.resolve('../automation/triggerBus/dispatch'));
    }
});

test('the arming query respects the mode somebody chose', async () => {
    // `manual` said "I will press the button" and `schedule` said "nightly is
    // fine". A meeting happening is not a reason to override either; a meeting
    // LEAVING a tag is, in every mode. The arms take their db through a seam.
    const { meetingArms } = require('../stores/kbSourcesMeetingArm');
    const sql = [];
    const arms = meetingArms({
        initDB: async () => {},
        run: async (q, params) => { sql.push({ q: q.replace(/\s+/g, ' '), params }); return { rowCount: 2 }; },
    });
    assert.strictEqual(await arms.armMeetingSources(['sales', ' ', 7]), 2);
    assert.match(sql[0].q, /refresh_mode = 'after_meeting'/);
    assert.match(sql[0].q, /kind = 'meeting_tag'/);
    // A running pass IS armed: its enumerate may already have run without this
    // meeting, and finish() keeps the arm (stores/kbSources.meetingArm.pg.test.js).
    assert.doesNotMatch(sql[0].q, /status <> 'refreshing'/, 'a meeting during a running pass still arms the source');
    assert.match(sql[0].q, /next_refresh_at = now\(\)/);
    assert.deepStrictEqual(sql[0].params, [['sales']]);

    await arms.armMeetingSourcesForRemoval(['sales']);
    assert.doesNotMatch(sql[1].q, /refresh_mode/, 'a removal arms every mode');
    assert.strictEqual(await arms.armMeetingSources([]), 0);
    assert.strictEqual(sql.length, 2, 'no tags, no query');
});
