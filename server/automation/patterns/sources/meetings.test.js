'use strict';

/**
 * The meeting source against a real Postgres (pglite), with the columns the
 * three stores declare.
 *
 * Run: cd server && node --test automation/patterns/sources/meetings.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { collectTeamsMeetings, collectGmeetMeetings, collectTalkMeetings } = require('./meetings');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const win = { now: NOW, since: NOW - 90 * DAY };
const at = (daysAgo, h = 9) => new Date(Date.UTC(2026, 9, 3) - daysAgo * DAY + h * 3_600_000).toISOString();

const { pg, db } = pgliteDb();
const ctx = (userId = 'u1') => ({ userId, ...win, deps: { db } });

before(async () => {
    await pg.exec(`
        CREATE TABLE teams_import_jobs (
            id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, calendar_event_id TEXT, series_master_id TEXT,
            join_url TEXT NOT NULL, title TEXT, meeting_start TIMESTAMPTZ, meeting_end TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'pending', transcription_id TEXT
        );
        CREATE TABLE gmeet_import_jobs (
            id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, ical_uid TEXT, meeting_code TEXT NOT NULL, title TEXT,
            meeting_start TIMESTAMPTZ, meeting_end TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'pending', transcription_id TEXT
        );
        CREATE TABLE transcriptions (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            duration_seconds INTEGER DEFAULT 0, source TEXT DEFAULT 'upload', talk_room_token TEXT, meet_meeting_code TEXT
        );
    `);
    const teams = [
        // [user, series, join, title, daysAgo, status]
        ['u1', 'SERIES-1', 'https://teams.example/j/1', 'Weekly sync 12', 7, 'ingested'],
        ['u1', 'SERIES-1', 'https://teams.example/j/1', 'Weekly sync 13', 14, 'no_recording'],
        ['u1', null, 'https://teams.example/j/9', 'One-off', 3, 'ingested'],   // join URL is the series
        ['u1', 'SERIES-1', 'https://teams.example/j/1', 'Opted out', 21, 'skipped'],
        ['u1', 'SERIES-1', 'https://teams.example/j/1', 'Too old', 120, 'ingested'],
        ['u2', 'SERIES-1', 'https://teams.example/j/1', 'Colleague', 7, 'ingested'],
    ];
    for (const [u, s, j, t, d, st] of teams) {
        await pg.query(
            `INSERT INTO teams_import_jobs (user_id, series_master_id, join_url, title, meeting_start, meeting_end, status)
             VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '30 minutes', $6)`,
            [u, s, j, t, at(d), st]);
    }
    const gmeet = [
        // [user, code, ical, daysAgo, status, transcription]
        ['u1', 'abc-defg-hij', 'uid-1@google.com', 2, 'ingested', 'tr-linked'],
        ['u1', 'abc-defg-hij', 'uid-1@google.com', 9, 'duplicate', null],
        ['u1', 'abc-defg-hij', 'uid-1@google.com', 9, 'no_recording', null], // same occurrence twice
        ['u1', 'xyz-xxxx-xxx', null, 16, 'no_conference', null],
    ];
    for (const [u, code, ical, d, st, tr] of gmeet) {
        await pg.query(
            `INSERT INTO gmeet_import_jobs (user_id, meeting_code, ical_uid, title, meeting_start, meeting_end, status, transcription_id)
             VALUES ($1, $2, $3, 'Planning', $4, $4::timestamptz + interval '1 hour', $5, $6)`,
            [u, code, ical, at(d), st, tr]);
    }
    const notes = [
        // [id, user, title, daysAgo, duration, talk, meet]
        ['tr-linked', 'u1', 'Planning', 2, 3600, null, 'abc-defg-hij'],      // produced by a job: not twice
        ['tr-own', 'u1', 'Planning', 23, 1800, null, 'abc-defg-hij'],        // captured by hand
        ['tr-talk-1', 'u1', 'Standup Monday', 1, 900, 'room-tok-1', null],
        ['tr-talk-2', 'u1', 'Standup Monday', 8, 900, 'room-tok-1', null],
        ['tr-plain', 'u1', 'Upload', 4, 600, null, null],                    // no series key
        ['tr-other', 'u2', 'Standup', 1, 900, 'room-tok-1', null],
    ];
    for (const [id, u, t, d, dur, talk, meet] of notes) {
        await pg.query(
            `INSERT INTO transcriptions (id, user_id, title, created_at, duration_seconds, talk_room_token, meet_meeting_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, u, t, at(d, 11), dur, talk, meet]);
    }
});
after(() => pg.close());

test('teams: own, held, not opted out, inside the window; series as an opaque key', async () => {
    const events = await collectTeamsMeetings(ctx());
    assert.strictEqual(events.length, 3);
    assert.ok(events.every((e) => e.source === 'meetings' && e.objectType === 'meeting' && e.app === 'teams' && e.verb === 'meeting.held'));
    const keys = new Set(events.map((e) => e.sessionKey));
    assert.strictEqual(keys.size, 2, 'the series and the one-off');
    assert.ok([...keys].every((k) => /^series:[0-9a-f]{16}$/.test(k)));
    assert.ok(events.every((e) => e.durationMs === 30 * 60_000));
    const text = JSON.stringify(events);
    assert.ok(!text.includes('SERIES-1') && !text.includes('teams.example'), 'no raw ids or URLs');
    assert.ok(!text.includes('Opted out') && !text.includes('Colleague') && !text.includes('Too old'));
    assert.deepStrictEqual(events.find((e) => e.template?.startsWith('Weekly'))?.template, 'Weekly sync <n>');
});

test('gmeet: jobs plus hand-made notes, each occurrence once, series = the Meet code', async () => {
    const events = await collectGmeetMeetings(ctx());
    // job day 2, job day 9 (two rows, one occurrence), hand-made note day 23.
    assert.strictEqual(events.length, 3);
    assert.strictEqual(new Set(events.map((e) => e.sessionKey)).size, 1, 'notes and jobs share the series');
    assert.ok(events.every((e) => e.app === 'gmeet'));
    assert.ok(events[0].ts < events[2].ts, 'oldest first');
    const own = events[0];
    assert.strictEqual(own.durationMs, 1800 * 1000);
    assert.strictEqual(own.ts, Date.parse(at(23, 11)) - 1800 * 1000, 'start = created minus the recording');
    assert.ok(!JSON.stringify(events).includes('abc-defg-hij'));
});

test('talk: meeting notes from a Talk room, by room token', async () => {
    const events = await collectTalkMeetings(ctx());
    assert.strictEqual(events.length, 2);
    assert.ok(events.every((e) => e.app === 'meetings' && e.template === 'Standup Monday'));
    assert.strictEqual(new Set(events.map((e) => e.sessionKey)).size, 1);
    assert.ok(!JSON.stringify(events).includes('room-tok'));
});

test('a missing table is no meetings, not a failure', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    const empty = pgliteDb(new PGlite());
    try {
        const c = { userId: 'u1', ...win, deps: { db: empty.db } };
        assert.deepStrictEqual(await collectTeamsMeetings(c), []);
        assert.deepStrictEqual(await collectGmeetMeetings(c), []);
        assert.deepStrictEqual(await collectTalkMeetings(c), []);
    } finally {
        await empty.pg.close();
    }
});

test('another database error is not swallowed', async () => {
    const broken = { query: async () => { throw Object.assign(new Error('connection reset'), { code: '08006' }); } };
    await assert.rejects(collectTeamsMeetings({ userId: 'u1', ...win, deps: { db: broken } }), /connection reset/);
});
