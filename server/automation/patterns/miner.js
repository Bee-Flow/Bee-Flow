// @typecheck
'use strict';
/**
 * Miner: from WorkEvents to repeating-work candidates. Deterministic; the LLM
 * never decides what repeats.
 *
 * Four kinds:
 *   sequence          the same ordered tool calls in many chat sessions
 *   mail_template     an inbound template the user reliably ACTS on, or a
 *                     template the user keeps sending themselves
 *   file_drop         files with one name template landing in one folder
 *   meeting_followup  a recurring meeting the user reliably acts on afterwards
 *
 * Never a pattern on its own: an inbound mail nobody acts on (newsletters,
 * bulk), a recurring meeting with no follow-up (a bare stand-up), a folder a
 * sync client fills in bursts, and anything from a source outside the contract.
 *
 * Gates: support >= 4, >= 3 distinct days, and below daily >= 3 of the last 6
 * weeks. Two exceptions, because a 90-day window cannot hold more: biweekly
 * needs 2 of the last 6 weeks, and monthly needs 3 occurrences in 3 different
 * months, the last within 40 days. A daily habit must still be going: its
 * last occurrence within the last 14 days (a month of daily work that
 * stopped in July is not repeating work in October). Irregular cadences need
 * more support. Under 14 days of history the gates relax and every candidate
 * is confidence 'early'.
 *
 * Weekdays and hours are the viewer's local ones when `timeZone` is passed
 * (periodicity.js); UTC otherwise.
 *
 * Pure: no I/O.
 */

const { SOURCES, isUserAction } = require('./events');
const { cadenceOf, median, DAY } = require('./periodicity');
const { sessionize, mineSequences } = require('./sequences');
const { clusterTemplates, tokenize } = require('./templating');

const HOUR = 3_600_000;
const COLD_START_DAYS = 14;
/** A daily habit whose last occurrence is older than this has stopped. */
const DAILY_STALE_DAYS = 14;

/** @typedef {import('./events').WorkEvent} WorkEvent */

/**
 * @typedef {{
 *   kind: 'sequence'|'mail_template'|'file_drop'|'meeting_followup',
 *   apps: string[], verbs: string[], verbApps: string[], templateIds: string[], template: string|null,
 *   occurrences: number, timestamps: number[], distinctDays: number,
 *   cadence: import('./periodicity').Cadence, confidence: 'early'|'normal'|'high',
 *   spansMs?: number[], direction?: 'in'|'out', domains?: string[], structured?: boolean,
 *   followRatio?: number
 * }} Candidate
 */

function gatesFor(cold) {
    return cold
        ? { support: 3, days: 2, recentWeeks: 0, irregularSupport: 3 }
        : { support: 4, days: 3, recentWeeks: 3, irregularSupport: 6 };
}

/** @returns {string|null} why the candidate fails, or null when it passes */
function gateFailure(cad, occurrences, cold, now) {
    const g = gatesFor(cold);
    if (cad.kind === 'monthly' && !cold) {
        if (occurrences < 3 || cad.monthsPresent < 3) return 'support';
        if (cad.lastTs == null || now - cad.lastTs > 40 * DAY) return 'stale';
        return null;
    }
    if (occurrences < g.support) return 'support';
    if (cad.distinctDays < g.days) return 'days';
    if (cold) return null;
    if (cad.kind === 'daily' || cad.kind === 'weekdays') {
        return cad.lastTs != null && now - cad.lastTs <= DAILY_STALE_DAYS * DAY ? null : 'stale';
    }
    if (cad.kind === 'biweekly') return cad.recentWeeks >= 2 ? null : 'recent';
    if (cad.recentWeeks < g.recentWeeks) return 'recent';
    if (cad.kind === 'irregular') {
        if (occurrences < g.irregularSupport || cad.distinctDays < 4) return 'irregular';
        if (cad.weeksPresent < cad.weeksWindow * 0.4) return 'irregular';
    }
    return null;
}

function confidenceOf(cad, occurrences, cold) {
    if (cold) return 'early';
    const stable = cad.kind === 'monthly' ? cad.monthsPresent >= 3 : cad.weeksPresent >= cad.weeksWindow * 0.6;
    if (stable && cad.kind !== 'irregular' && occurrences >= 6) return 'high';
    return 'normal';
}

/**
 * Which user actions reliably follow the anchors (a mail arriving, a meeting
 * ending)? A verb counts when it follows at least half the anchors AND is
 * clearly more likely after an anchor than on an ordinary day (lift >= 1.5):
 * someone who uses Sheets every day does not "follow up" on every meeting.
 */
function followUps(anchors, actions, opts) {
    const windowMs = opts.windowHours * HOUR;
    const exclude = opts.exclude || new Set();
    /** @type {Map<string, { count: number, delays: number[], app: string }>} */
    const stats = new Map();
    let j0 = 0;
    for (const a of anchors) {
        while (j0 < actions.length && actions[j0].ts < a.ts) j0++;
        const seen = new Set();
        for (let j = j0; j < actions.length && actions[j].ts <= a.ts + windowMs; j++) {
            const e = actions[j];
            if (exclude.has(e) || seen.has(e.verb)) continue;
            seen.add(e.verb);
            const s = stats.get(e.verb) || { count: 0, delays: [], app: e.app };
            s.count++;
            s.delays.push(e.ts - a.ts);
            stats.set(e.verb, s);
        }
    }
    const result = [];
    for (const [verb, s] of stats) {
        const ratio = s.count / anchors.length;
        const baseline = Math.min(1, (opts.daysWithVerb.get(verb) || 0) / opts.spanDays) * Math.min(1, opts.windowHours / 24);
        const lift = baseline > 0 ? ratio / baseline : Infinity;
        if (ratio >= 0.5 && lift >= 1.5) result.push({ verb, app: s.app, ratio, delay: median(s.delays) });
    }
    result.sort((a, b) => a.delay - b.delay);
    return result.slice(0, 3);
}

/** Cluster the distinct templates of a group of events, keyed by event. */
function clusterEvents(events) {
    const distinct = [...new Set(events.map((e) => e.template).filter(Boolean))];
    const { clusters, assignment } = clusterTemplates(distinct);
    /** @type {Map<string, { templateId: string, template: string }>} */
    const byTemplate = new Map();
    distinct.forEach((t, i) => {
        const c = clusters[assignment[i]];
        if (c) byTemplate.set(t, { templateId: c.templateId, template: c.template });
    });
    return byTemplate;
}

/** A template made only of placeholders says nothing about what repeats. */
function informative(template) {
    return tokenize(template).some((t) => !t.startsWith('<'));
}

function groupBy(list, keyFn) {
    /** @type {Map<string, any[]>} */
    const m = new Map();
    for (const x of list) {
        const k = keyFn(x);
        if (k == null) continue;
        const arr = m.get(k) || [];
        arr.push(x);
        m.set(k, arr);
    }
    return m;
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

const BURST_MS = 2 * 60_000;

/** Sync clients drop files in bursts or around the clock; people do not. */
function looksAutoSynced(group) {
    const perDay = [...groupBy(group, (e) => String(Math.floor(e.ts / DAY))).values()].map((l) => l.length);
    if (median(perDay) > 6) return true;
    // An event is in a burst when 4+ others land within two minutes of it:
    // a sliding window over the sorted times, linear after the sort.
    const ts = group.map((e) => e.ts).sort((a, b) => a - b);
    let inBurst = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < ts.length; i++) {
        while (ts[i] - ts[lo] > BURST_MS) lo++;
        while (hi + 1 < ts.length && ts[hi + 1] - ts[i] <= BURST_MS) hi++;
        if (hi - lo >= 4) inBurst++;
    }
    return inBurst >= ts.length * 0.5;
}

/**
 * @param {any[]} events WorkEvents
 * @param {{ now?: number, windowDays?: number, timeZone?: string|null, tzOffsetMinutes?: number }} [opts]
 * @returns {{ candidates: Candidate[], reason: 'not_enough_history'|'no_patterns'|null, coldStart: boolean,
 *             historyDays: number, rejected: Record<string, number> }}
 */
function minePatterns(events, opts = {}) {
    const now = opts.now ?? Date.now();
    const windowDays = opts.windowDays ?? 90;
    const since = now - windowDays * DAY;
    /** @type {Record<string, number>} */
    const rejected = {};
    const reject = (why) => { rejected[why] = (rejected[why] || 0) + 1; };

    /** @type {WorkEvent[]} */
    const evs = [];
    for (const e of events || []) {
        if (!e || !SOURCES.includes(e.source)) { reject('unknown_source'); continue; }
        if (!Number.isFinite(e.ts) || e.ts < since || e.ts > now) continue;
        evs.push(e);
    }
    evs.sort((a, b) => a.ts - b.ts);
    const historyDays = evs.length ? (now - evs[0].ts) / DAY : 0;
    const cold = historyDays < COLD_START_DAYS;
    if (!evs.length) return { candidates: [], reason: 'not_enough_history', coldStart: true, historyDays: 0, rejected };

    const g = gatesFor(cold);
    const cadOpts = { now, windowDays, historyDays: Math.max(historyDays, 1), timeZone: opts.timeZone ?? null, tzOffsetMinutes: opts.tzOffsetMinutes };
    const actions = evs.filter(isUserAction);
    const spanDays = Math.max(1, Math.ceil(historyDays));
    /** @type {Map<string, number>} */
    const daysWithVerb = new Map();
    for (const [verb, list] of groupBy(actions, (e) => e.verb)) {
        daysWithVerb.set(verb, new Set(list.map((e) => Math.floor(e.ts / DAY))).size);
    }

    /** @type {Candidate[]} */
    const out = [];
    const accept = (base, timestamps) => {
        const cadence = cadenceOf(timestamps, cadOpts);
        const why = gateFailure(cadence, timestamps.length, cold, now);
        if (why) { reject(`gate_${why}`); return; }
        out.push({
            ...base,
            occurrences: timestamps.length,
            timestamps,
            distinctDays: cadence.distinctDays,
            cadence,
            confidence: confidenceOf(cadence, timestamps.length, cold),
        });
    };

    // ── sequence: tool calls in chat sessions ──
    const tools = evs.filter((e) => e.source === 'ledger');
    const sessions = sessionize(tools, { gapMin: 45 });
    for (const p of mineSequences(sessions, { minSupport: g.support, minDays: g.days, minLen: 2, maxLen: 4 })) {
        accept({
            kind: 'sequence', apps: p.apps, verbs: p.verbs, verbApps: p.verbApps,
            templateIds: [], template: null, spansMs: p.spansMs, structured: false,
        }, p.timestamps);
    }

    // ── mail_template ──
    const mail = evs.filter((e) => e.objectType === 'mail' && e.template);
    const mailClusters = clusterEvents(mail);
    const mailGroups = groupBy(mail, (e) => {
        const c = mailClusters.get(e.template);
        return c && informative(c.template) ? `${e.direction || 'in'}|${e.app}|${c.templateId}` : null;
    });
    for (const [key, group] of mailGroups) {
        const [direction, app] = key.split('|');
        const c = mailClusters.get(group[0].template);
        const domains = uniq(group.map((e) => e.domainPseudo));
        const structured = /<(?:n|id|date)>/.test(c.template) || group.filter((e) => e.hasAttachment).length >= group.length / 2;
        const base = { kind: 'mail_template', templateIds: [c.templateId], template: c.template, direction, domains, structured };
        if (direction === 'out') {
            accept({ ...base, apps: [app], verbs: ['mail.sent'], verbApps: [app] }, group.map((e) => e.ts));
            continue;
        }
        if (group.length < g.support) { reject('gate_support'); continue; }
        const follows = followUps(group, actions, { windowHours: 24, daysWithVerb, spanDays });
        if (!follows.length) { reject(group.some((e) => e.bulk) ? 'bulk_no_action' : 'inbound_no_action'); continue; }
        // Bulk mail needs a stronger signal: most of it must be acted on.
        if (group.some((e) => e.bulk) && Math.max(...follows.map((f) => f.ratio)) < 0.75) { reject('bulk_no_action'); continue; }
        accept({
            ...base,
            apps: uniq([app, ...follows.map((f) => f.app)]),
            verbs: ['mail.received', ...follows.map((f) => f.verb)],
            verbApps: [app, ...follows.map((f) => f.app)],
            followRatio: Math.min(...follows.map((f) => f.ratio)),
            spansMs: follows.length ? [follows[follows.length - 1].delay] : [],
        }, group.map((e) => e.ts));
    }

    // ── file_drop ──
    const files = evs.filter((e) => (e.source === 'files' || e.source === 'documents')
        && (e.verb === 'file.created' || e.verb === 'doc.uploaded') && e.template);
    const fileClusters = clusterEvents(files);
    const fileGroups = groupBy(files, (e) => {
        const c = fileClusters.get(e.template);
        return c && informative(c.template) ? `${e.app}|${e.sessionKey || ''}|${c.templateId}` : null;
    });
    for (const [key, group] of fileGroups) {
        if (looksAutoSynced(group)) { reject('autosync'); continue; }
        const app = key.split('|')[0];
        const c = fileClusters.get(group[0].template);
        accept({
            kind: 'file_drop', apps: [app], verbs: [group[0].verb], verbApps: [app],
            templateIds: [c.templateId], template: c.template, structured: /<(?:n|id|date)>/.test(c.template),
        }, group.map((e) => e.ts));
    }

    // ── meeting_followup ──
    const meetings = evs.filter((e) => e.objectType === 'meeting' && e.verb === 'meeting.held');
    // Without a series key there is no recurrence to speak of: lumping every
    // meeting of one app together would invent a series.
    const seriesKey = (e) => (e.sessionKey || e.templateId ? `${e.app}|${e.sessionKey || e.templateId}` : null);
    for (const [, group] of groupBy(meetings, seriesKey)) {
        if (group.length < g.support) { reject('gate_support'); continue; }
        const follows = followUps(group, actions, { windowHours: 24, daysWithVerb, spanDays });
        if (!follows.length) { reject('bare_meeting'); continue; }
        const app = group[0].app;
        accept({
            kind: 'meeting_followup',
            apps: uniq([app, ...follows.map((f) => f.app)]),
            verbs: ['meeting.held', ...follows.map((f) => f.verb)],
            verbApps: [app, ...follows.map((f) => f.app)],
            templateIds: uniq(group.map((e) => e.templateId)).slice(0, 1),
            template: group[0].template || null,
            followRatio: Math.min(...follows.map((f) => f.ratio)),
            spansMs: [follows[follows.length - 1].delay],
            structured: false,
        }, group.map((e) => e.ts));
    }

    const candidates = dedupe(out);
    const reason = candidates.length ? null : (cold ? 'not_enough_history' : 'no_patterns');
    return { candidates, reason, coldStart: cold, historyDays: Math.round(historyDays * 10) / 10, rejected };
}

/**
 * One habit, one card: drop a candidate whose verbs are all inside a richer
 * candidate that happens at the same times (the tool sequence that IS the
 * follow-up of an invoice mail, the recap mail that IS a meeting follow-up).
 * @param {Candidate[]} list
 */
function dedupe(list) {
    const covered = (b, a) => {
        if (a === b || a.verbs.length <= b.verbs.length) return false;
        const av = new Set(a.verbs);
        if (!b.verbs.every((v) => av.has(v))) return false;
        let hits = 0;
        for (const t of b.timestamps) {
            if (a.timestamps.some((s) => t >= s - HOUR && t <= s + 24 * HOUR)) hits++;
        }
        return hits >= b.timestamps.length * 0.5;
    };
    return list.filter((b) => !list.some((a) => covered(b, a)));
}

module.exports = { minePatterns, followUps, gateFailure, looksAutoSynced, COLD_START_DAYS };
