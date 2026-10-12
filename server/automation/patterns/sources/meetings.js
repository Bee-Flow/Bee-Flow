// @typecheck
'use strict';
/**
 * Pattern source: the user's recurring meetings, from what Bee Flow already
 * stores.
 *
 *   teams      teams_import_jobs, series = series_master_id (else the join
 *              URL, which a recurring Teams meeting keeps)
 *   gmeet      gmeet_import_jobs, series = meeting_code (else ical_uid), plus
 *              meeting notes captured with a Meet code that no import job
 *              produced
 *   meetings   meeting notes recorded in a Nextcloud Talk room, series = the
 *              room token
 *
 * Only `meeting.held` events WITH a series key are emitted: without one there
 * is no recurrence to speak of. A meeting on its own is never a pattern; the
 * miner pairs a series with the user's follow-up actions and drops a bare
 * stand-up. Series ids leave as opaque hashes, titles as templates (the
 * pipeline masks names in templates before anything reaches a model).
 *
 * Skipped import jobs are left out: that status means the user opted that
 * meeting out of meeting notes. A table or column an older install lacks
 * reads as "no meetings", never as a failed scan.
 */

const { makeEvent } = require('../events');
const { subjectTemplate } = require('../templating');
const { DAY, toMs, inWindow, opaqueKey, defaultDb, queryRows } = require('./common');

const ROW_LIMIT = 2000;
const MAX_DURATION_MS = 12 * 3_600_000;

/** @typedef {import('./common').Db} Db */

function durationOf(start, end) {
    const d = end - start;
    return Number.isFinite(d) && d > 0 && d <= MAX_DURATION_MS ? d : undefined;
}

/**
 * One event per (series, start minute): two job rows for one occurrence are
 * one meeting.
 */
function meetingEvents(items, win) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        if (!it.seriesId || !inWindow(it.ts, win)) continue;
        const sessionKey = opaqueKey('series', `${it.app}|${it.seriesId}`);
        const dedupe = `${sessionKey}|${Math.floor(it.ts / 60_000)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const title = typeof it.title === 'string' ? it.title.trim() : '';
        const ev = makeEvent({
            ts: it.ts,
            source: 'meetings',
            objectType: 'meeting',
            app: it.app,
            verb: 'meeting.held',
            sessionKey,
            template: title ? subjectTemplate(title) : null,
            durationMs: it.durationMs,
        });
        if (ev) out.push(ev);
    }
    return out;
}

/** @param {{ userId: string, since: number, now: number, deps?: { db?: Db } }} ctx */
function args(ctx) {
    return { db: ctx.deps?.db || defaultDb(), params: [String(ctx.userId), new Date(ctx.since).toISOString(), new Date(ctx.now).toISOString()] };
}

/**
 * @param {{ userId: string, since: number, now: number, deps?: { db?: Db } }} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectTeamsMeetings(ctx) {
    if (!ctx?.userId) return [];
    const { db, params } = args(ctx);
    const rows = await queryRows(db, `
        SELECT series_master_id, join_url, title, meeting_start, meeting_end
          FROM teams_import_jobs
         WHERE user_id = $1 AND meeting_start >= $2 AND meeting_start <= $3
           AND status <> 'skipped'
         ORDER BY meeting_start
         LIMIT ${ROW_LIMIT}`, params);
    return meetingEvents(rows.map((r) => {
        const ts = toMs(r.meeting_start);
        return {
            app: 'teams', ts, title: r.title,
            seriesId: r.series_master_id || r.join_url || null,
            durationMs: durationOf(ts, toMs(r.meeting_end)),
        };
    }), ctx);
}

/**
 * @param {{ userId: string, since: number, now: number, deps?: { db?: Db } }} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectGmeetMeetings(ctx) {
    if (!ctx?.userId) return [];
    const { db, params } = args(ctx);
    // A day of slack below the window: a note created just inside the window
    // can belong to a job that started just outside it.
    const jobParams = [params[0], new Date(ctx.since - DAY).toISOString(), params[2]];
    const jobs = await queryRows(db, `
        SELECT meeting_code, ical_uid, title, meeting_start, meeting_end, transcription_id
          FROM gmeet_import_jobs
         WHERE user_id = $1 AND meeting_start >= $2 AND meeting_start <= $3
           AND status NOT IN ('skipped', 'no_conference')
         ORDER BY meeting_start
         LIMIT ${ROW_LIMIT}`, jobParams);
    const linked = new Set(jobs.map((j) => j.transcription_id).filter(Boolean).map(String));
    const notes = await queryRows(db, `
        SELECT id, title, created_at, duration_seconds, meet_meeting_code
          FROM transcriptions
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND meet_meeting_code IS NOT NULL
         ORDER BY created_at
         LIMIT ${ROW_LIMIT}`, params);

    const items = jobs.map((r) => {
        const ts = toMs(r.meeting_start);
        return {
            app: 'gmeet', ts, title: r.title,
            seriesId: r.meeting_code || r.ical_uid || null,
            durationMs: durationOf(ts, toMs(r.meeting_end)),
        };
    });
    for (const n of notes) {
        if (linked.has(String(n.id))) continue;
        items.push({ app: 'gmeet', title: n.title, seriesId: n.meet_meeting_code, ...noteTiming(n) });
    }
    items.sort((a, b) => a.ts - b.ts);
    return meetingEvents(items, ctx);
}

/**
 * A note is created when the recording is processed, after the meeting: the
 * start is roughly the creation time minus the recording's length.
 */
function noteTiming(n) {
    const created = toMs(n.created_at);
    const secs = Number(n.duration_seconds);
    const durationMs = Number.isFinite(secs) && secs > 0 ? durationOf(0, secs * 1000) : undefined;
    return { ts: durationMs ? created - durationMs : created, durationMs };
}

/**
 * @param {{ userId: string, since: number, now: number, deps?: { db?: Db } }} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectTalkMeetings(ctx) {
    if (!ctx?.userId) return [];
    const { db, params } = args(ctx);
    const notes = await queryRows(db, `
        SELECT title, created_at, duration_seconds, talk_room_token
          FROM transcriptions
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND talk_room_token IS NOT NULL
         ORDER BY created_at
         LIMIT ${ROW_LIMIT}`, params);
    return meetingEvents(notes.map((n) => ({
        app: 'meetings', title: n.title, seriesId: n.talk_room_token, ...noteTiming(n),
    })), ctx);
}

module.exports = { collectTeamsMeetings, collectGmeetMeetings, collectTalkMeetings };
