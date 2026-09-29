/**
 * freshness — how current a knowledge base's content is, as one row-level
 * verdict (Knowledge artboard 1c-right, plan K2).
 *
 * The artboard draws three different right-hand cells on three KBs, and they
 * are three different KINDS of statement, not three phrasings of one:
 *
 *   ● bijgewerkt 2 min   something arrived recently — a FACT about content
 *   ● wekelijks · ma     nothing arrived recently, but a source will fetch
 *                        on its own — a PROMISE about the future
 *   ⚠ leeg, wel in gebruik   nothing has ever arrived AND something depends
 *                        on it — a PROBLEM someone must act on
 *
 * Ordering them matters: the problem wins over the promise, and the promise
 * wins over an old fact. A knowledge base with a weekly schedule that has
 * never been filled is broken today, not "weekly"; saying "weekly · ma"
 * there would be a true sentence that hides the only thing worth knowing.
 *
 * Pure: no clock, no fetch, no t(). The verdict is decided entirely by the
 * row's own fields, so every rule below can be tested at its boundary — and
 * the WHEN of "bijgewerkt 2 min" is the caller's `useRelativeTime`, which is
 * where relative time already lives.
 *
 * The module returns KEYS and PARAMETERS, never sentences. The caller runs
 * them through t(), so the same verdict speaks Dutch on a Dutch install —
 * and renders the "2 min" of "bijgewerkt 2 min" with `useRelativeTime`,
 * which is where relative time already lives.
 */

/** Verdict tones — the caller maps these onto the theme's status tokens. */
export const TONE = Object.freeze({
    OK: 'ok',           // --success dot
    IDLE: 'idle',       // neutral dot: nothing wrong, nothing recent
    PROBLEM: 'problem', // --error, with an icon rather than a dot
});

/** ms since epoch from a Date, a number, or an ISO string; null when unusable. */
export function toMillis(at) {
    if (at === null || at === undefined || at === '') return null;
    const ts = at instanceof Date ? at.getTime() : (typeof at === 'number' ? at : Date.parse(at));
    return Number.isFinite(ts) ? ts : null;
}

/**
 * The one auto-refresh promise a KB can make, folded from its sources.
 *
 * A KB with several scheduled sources gets ONE line, and it is the most
 * frequent of them: that is the interval after which the KB as a whole is
 * current again. Taking the least frequent would promise staleness the KB
 * does not actually have; listing all of them turns a status cell into a
 * table.
 *
 * `live` beats `on_change` beats `after_meeting` beats `schedule`, in that
 * order — a live source means the answer is never older than the question.
 */
export const REFRESH_RANK = Object.freeze({ live: 4, on_change: 3, after_meeting: 2, schedule: 1, manual: 0 });

export function strongestRefresh(sources = []) {
    let best = null;
    for (const s of Array.isArray(sources) ? sources : []) {
        const mode = s?.refreshMode || s?.refresh_mode || 'manual';
        const rank = REFRESH_RANK[mode] ?? 0;
        if (rank === 0) continue;
        if (!best || rank > best.rank) best = { rank, mode, source: s };
    }
    return best;
}

/**
 * The verdict for one KB row.
 *
 * @param {object} kb        `{ lastContentAt, documentCount, sourceCount }` (the
 *                           K1b list payload; snake_case aliases accepted)
 * @param {object} opts
 * @param {Array}  opts.sources  the KB's sources, when the caller has them —
 *                           the overview list does not, so a KB there gets its
 *                           promise from `autoRefreshCount` instead
 * @param {number} opts.usageCount  how many things use it (K5's usage summary;
 *                           0 when not loaded — an UNKNOWN usage must never
 *                           raise the alarm, only a known-nonzero one)
 * @returns {{ tone, key, params, at }} — `at` is the timestamp the caller
 *          may also render as a title attribute.
 */
export function freshnessOf(kb = {}, { sources = null, usageCount = 0 } = {}) {
    const documentCount = num(kb.documentCount ?? kb.document_count);
    const lastContentAt = toMillis(kb.lastContentAt ?? kb.last_content_at);

    // The problem case first: empty, and something is pointing at it. An
    // agent wired to an empty knowledge base answers from nothing and says
    // nothing about why, which is the failure this cell exists to surface.
    if (documentCount === 0 && usageCount > 0) {
        return { tone: TONE.PROBLEM, key: 'knowledge.freshness.empty_in_use', params: {}, at: null };
    }

    // Content has arrived at some point: say when. The WHEN is left to the
    // caller's `useRelativeTime`, which already owns the product's relative
    // vocabulary and its locale — a second one here would drift from it.
    if (lastContentAt !== null) {
        return { tone: TONE.OK, key: 'knowledge.freshness.updated', params: {}, at: lastContentAt };
    }

    // Nothing yet, but a source will fetch on its own.
    const auto = sources ? strongestRefresh(sources) : null;
    const autoCount = sources ? (auto ? 1 : 0) : num(kb.autoRefreshCount ?? kb.auto_refresh_count);
    if (autoCount > 0) {
        return {
            tone: TONE.IDLE,
            key: auto ? refreshModeKey(auto.mode) : 'knowledge.freshness.auto',
            params: auto?.mode === 'schedule' ? cronParams(auto.source) : {},
            at: null,
        };
    }

    // Nothing, ever, and nothing scheduled.
    if (num(kb.sourceCount ?? kb.source_count) === 0) {
        return { tone: TONE.IDLE, key: 'knowledge.freshness.no_sources', params: {}, at: null };
    }
    return { tone: TONE.IDLE, key: 'knowledge.freshness.never', params: {}, at: null };
}

/** The i18n key for a refresh mode, as the source table's "Verversen" cell says it. */
export function refreshModeKey(mode) {
    switch (mode) {
        case 'live': return 'knowledge.refresh.live';
        case 'on_change': return 'knowledge.refresh.on_change';
        case 'after_meeting': return 'knowledge.refresh.after_meeting';
        case 'schedule': return 'knowledge.refresh.schedule';
        default: return 'knowledge.refresh.manual';
    }
}

/**
 * "wekelijks · ma" from a source's cron — the artboard's own phrasing.
 *
 * Only the shapes the schedule chooser can PRODUCE are named (K3 owns that
 * chooser); anything hand-written or six-field falls back to a plain
 * "volgens schema", because a wrong human sentence about when data refreshes
 * is worse than a vague true one.
 */
export function cronParams(source) {
    const cron = source?.refreshCron || source?.refresh_cron || '';
    const parts = String(cron).trim().split(/\s+/);
    if (parts.length !== 5) return {};
    const [, , dom, , dow] = parts;
    if (dow !== '*' && /^[0-6]$/.test(dow)) return { every: 'week', day: Number(dow) };
    if (dom !== '*' && /^\d{1,2}$/.test(dom)) return { every: 'month', day: Number(dom) };
    if (dom === '*' && dow === '*') return { every: 'day' };
    return {};
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
