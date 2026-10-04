// @typecheck
'use strict';
/**
 * Sequences: which ordered runs of actions keep coming back.
 *
 *   sessionize(events, { gapMin })   events sharing a sessionKey (a chat
 *     conversation) form one session, split again on a long pause; events
 *     without a key are cut into sessions by time gap.
 *   mineSequences(sessions, opts)    PrefixSpan-lite over the verb lists of
 *     those sessions, with a gap limit between steps. Support counts sessions,
 *     not repeats inside one; a pattern must beat chance, every step must earn
 *     its place, and only CLOSED patterns survive (no longer pattern with the
 *     same support).
 *
 * Pure: no I/O.
 */

const { DAY } = require('./periodicity');

/** @typedef {import('./events').WorkEvent} WorkEvent */
/** @typedef {{ key: string, events: WorkEvent[], start: number, end: number }} Session */

/**
 * @param {WorkEvent[]} events
 * @param {{ gapMin?: number, keyedGapMin?: number }} [opts]
 * @returns {Session[]}
 */
function sessionize(events, opts = {}) {
    const gapMs = (opts.gapMin ?? 45) * 60_000;
    // A conversation can stay open for days; a pause this long starts new work.
    const keyedGapMs = (opts.keyedGapMin ?? 180) * 60_000;
    const sorted = [...(events || [])].sort((a, b) => a.ts - b.ts);
    /** @type {Map<string, WorkEvent[]>} */
    const byKey = new Map();
    /** @type {WorkEvent[]} */
    const loose = [];
    for (const e of sorted) {
        if (e.sessionKey) {
            const list = byKey.get(e.sessionKey) || [];
            list.push(e);
            byKey.set(e.sessionKey, list);
        } else {
            loose.push(e);
        }
    }
    /** @type {Session[]} */
    const sessions = [];
    const cut = (list, gap, keyBase) => {
        let cur = [];
        let part = 0;
        for (const e of list) {
            if (cur.length && e.ts - cur[cur.length - 1].ts > gap) {
                sessions.push({ key: `${keyBase}#${part++}`, events: cur, start: cur[0].ts, end: cur[cur.length - 1].ts });
                cur = [];
            }
            cur.push(e);
        }
        if (cur.length) sessions.push({ key: `${keyBase}#${part}`, events: cur, start: cur[0].ts, end: cur[cur.length - 1].ts });
    };
    for (const [key, list] of byKey) cut(list, keyedGapMs, key);
    cut(loose, gapMs, 'gap');
    return sessions.sort((a, b) => a.start - b.start);
}

/** Verb list of a session with immediate repeats collapsed, capped. */
function itemsOf(session, maxItems) {
    const items = [];
    const apps = [];
    for (const e of session.events) {
        if (items[items.length - 1] === e.verb) continue;
        items.push(e.verb);
        apps.push(e.app);
        if (items.length >= maxItems) break;
    }
    return { items, apps };
}

/**
 * @typedef {{
 *   verbs: string[], apps: string[], verbApps: string[], support: number,
 *   sessionIdx: number[], timestamps: number[], spansMs: number[], distinctDays: number
 * }} SequencePattern
 */

// A projection maps a session to { end position of the last matched step →
// the latest start position that reaches it } (latest = the tightest span).
/** @typedef {Map<number, Map<number, number>>} Projection */

/**
 * One PrefixSpan step: every verb that can follow the node's pattern within
 * the gap, with its projection. The root (no verbs yet) starts anywhere.
 * @param {Array<{ items: string[] }>} db
 * @param {{ verbs: string[], occ: Projection }} node
 * @param {number} maxGap
 * @returns {Map<string, Projection>}
 */
function extend(db, node, maxGap) {
    const root = node.verbs.length === 0;
    /** @type {Map<string, Projection>} */
    const ext = new Map();
    for (const [i, ends] of node.occ) {
        const items = db[i].items;
        for (const [end, begin] of ends) {
            const to = root ? items.length - 1 : Math.min(items.length - 1, end + 1 + maxGap);
            for (let j = end + 1; j <= to; j++) {
                const v = items[j];
                let bySession = ext.get(v);
                if (!bySession) { bySession = new Map(); ext.set(v, bySession); }
                let e = bySession.get(i);
                if (!e) { e = new Map(); bySession.set(i, e); }
                const b = root ? j : begin;
                if (!e.has(j) || /** @type {number} */ (e.get(j)) < b) e.set(j, b);
            }
        }
    }
    return ext;
}

/**
 * @typedef {{
 *   minSupport?: number, minDays?: number, minLen?: number, maxLen?: number, maxItems?: number,
 *   maxGap?: number, minLift?: number, minConfidence?: number, minProductive?: number,
 *   maxPatterns?: number, maxNodes?: number
 * }} MineOptions
 */

/**
 * PrefixSpan-lite with a gap constraint: two consecutive steps of a pattern
 * may have at most `maxGap` other actions between them, so a long session
 * does not "contain" every ordered pair of the tools it happens to use.
 *
 * A frequent pattern must also be more than chance. It passes when its lift
 * (support over what independent use of its tools would give) is at least
 * `minLift`, OR when it follows its rarest tool at least `minConfidence` of
 * the time (someone who does little else than triage still has a triage
 * habit). Each step must also be productive (see below), so a random tool in
 * front of a real habit does not ride along as a second pattern. Exploration
 * and output are capped, so a heavy history stays cheap.
 *
 * @param {Session[]} sessions
 * @param {MineOptions} [opts]
 * @returns {SequencePattern[]}
 */
function mineSequences(sessions, opts = {}) {
    const minSupport = opts.minSupport ?? 4;
    const minDays = opts.minDays ?? 3;
    const minLen = opts.minLen ?? 2;
    const maxLen = opts.maxLen ?? 4;
    const maxItems = opts.maxItems ?? 20;
    const maxGap = opts.maxGap ?? 3;
    const minLift = opts.minLift ?? 2;
    const minConfidence = opts.minConfidence ?? 0.75;
    const minProductive = opts.minProductive ?? 1.5;
    const maxPatterns = opts.maxPatterns ?? 40;
    const maxNodes = opts.maxNodes ?? 50_000;
    const db = sessions.map((s) => itemsOf(s, maxItems));
    const N = db.length;

    /** Sessions holding each verb. */
    const itemSupport = new Map();
    for (const { items } of db) for (const v of new Set(items)) itemSupport.set(v, (itemSupport.get(v) || 0) + 1);

    const keyOf = (/** @type {string[]} */ verbs) => verbs.join('\u0001');
    /** Support of every pattern explored, significant or not. */
    const supportOf = new Map();
    const significant = (/** @type {string[]} */ verbs, /** @type {number} */ support) => {
        const counts = verbs.map((v) => itemSupport.get(v) || 1);
        const expected = counts.reduce((acc, c) => acc * (c / N), N);
        const lift = expected > 0 ? support / expected : Infinity;
        return lift >= minLift || support / Math.min(...counts) >= minConfidence;
    };

    // Level by level, so a capped exploration still finishes the short
    // patterns. Single tools always grow; a longer pattern grows only while it
    // is significant: every prefix of a real habit is, while random pairs are
    // not, which keeps a dense history from exploding into random triples.
    /** @type {Array<{ verbs: string[], occ: Projection }>} */
    const found = [];
    /** @type {Array<{ verbs: string[], occ: Projection }>} */
    let frontier = [{ verbs: [], occ: new Map(db.map((_, i) => [i, new Map([[-1, -1]])])) }];
    let nodes = 0;
    for (let depth = 0; depth < maxLen && frontier.length && nodes < maxNodes; depth++) {
        /** @type {typeof frontier} */
        const next = [];
        for (const node of frontier) {
            for (const [v, occ] of extend(db, node, maxGap)) {
                if (occ.size < minSupport || ++nodes > maxNodes) continue;
                const verbs = [...node.verbs, v];
                if (verbs.length === 1) { next.push({ verbs, occ }); continue; }
                supportOf.set(keyOf(verbs), occ.size);
                if (!significant(verbs, occ.size)) continue;
                next.push({ verbs, occ });
                if (verbs.length >= minLen) found.push({ verbs, occ });
            }
        }
        frontier = next;
    }

    // Every step has to earn its place: without it the rest must not happen
    // just as often (then the step is a hanger-on, like a tool that shows up
    // in half of all sessions anyway). A step is justified when the pattern
    // keeps `minConfidence` of the rest's support, or beats chance by
    // `minProductive` against the rest.
    const productive = (/** @type {string[]} */ verbs, /** @type {number} */ support) => {
        for (let k = 0; k < verbs.length; k++) {
            const rest = verbs.filter((_, i) => i !== k);
            const restSupport = rest.length === 1 ? itemSupport.get(rest[0]) : supportOf.get(keyOf(rest));
            // Unknown: the rest broke the gap rule or was never explored.
            if (!restSupport) continue;
            const p = (itemSupport.get(verbs[k]) || 1) / N;
            if (support < restSupport * minConfidence && support < restSupport * p * minProductive) return false;
        }
        return true;
    };

    /** @type {SequencePattern[]} */
    const patterns = [];
    for (const f of found) {
        const support = f.occ.size;
        if (!productive(f.verbs, support)) continue;

        const sessionIdx = [...f.occ.keys()].sort((a, b) => a - b);
        const dayKeys = new Set(sessionIdx.map((i) => Math.floor(sessions[i].start / DAY)));
        if (dayKeys.size < minDays) continue;
        const apps = [];
        const verbApps = f.verbs.map((v) => {
            const i = sessionIdx[0];
            const k = db[i].items.indexOf(v);
            return k >= 0 ? db[i].apps[k] : '';
        });
        for (const a of verbApps) if (a && !apps.includes(a)) apps.push(a);
        const spansMs = sessionIdx.map((i) => {
            // The tightest occurrence in this session.
            let best = null;
            for (const [end, begin] of /** @type {Map<number, number>} */ (f.occ.get(i))) {
                if (!best || end - begin < best[0] - best[1]) best = [end, begin];
            }
            const evs = sessions[i].events;
            // Item positions map back to event timestamps (items collapse repeats).
            return best ? Math.max(0, tsOfItem(evs, best[0], true) - tsOfItem(evs, best[1])) : 0;
        });
        patterns.push({
            verbs: f.verbs,
            apps,
            verbApps,
            support,
            sessionIdx,
            timestamps: sessionIdx.map((i) => sessions[i].start),
            spansMs,
            distinctDays: dayKeys.size,
        });
    }
    // Closed patterns only: drop one that a longer pattern contains with
    // (nearly) the same support. "search → append" vanishes into
    // "search → read → append" when they always happen together.
    const closed = patterns.filter((p) => !patterns.some((q) => q !== p
        && q.verbs.length > p.verbs.length
        && q.support >= p.support * 0.9
        && isSubsequence(p.verbs, q.verbs)));
    return closed
        .sort((a, b) => b.support - a.support || b.verbs.length - a.verbs.length)
        .slice(0, maxPatterns);
}

/** Timestamp of the k-th collapsed item; `last` takes the last event of a repeat run. */
function tsOfItem(events, k, last = false) {
    let idx = -1;
    for (let j = 0; j < events.length; j++) {
        if (j === 0 || events[j].verb !== events[j - 1].verb) idx++;
        if (idx === k) {
            if (!last) return events[j].ts;
            let m = j;
            while (m + 1 < events.length && events[m + 1].verb === events[j].verb) m++;
            return events[m].ts;
        }
    }
    return events.length ? events[events.length - 1].ts : 0;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function isSubsequence(a, b) {
    let i = 0;
    for (const x of b) if (x === a[i]) i++;
    return i === a.length;
}

module.exports = { sessionize, mineSequences, isSubsequence };
