/**
 * railMeta — the right-hand meta of every rail row ('Compliance Rail.dc.html').
 *
 * ONE rule: the meta shows an ACTIONABLE count, as "{n} {state}" ("2 high",
 * "61 to decide", "1 review overdue"), and nothing when the row is clean. The
 * framework rows keep their score (and, in the "Needs attention" view, show
 * "{n} to fix"); DSR and incidents keep their clocks. What used to sit there
 * as static or background text (the last run, "DPO · legal bases", the sweep
 * time, the ROPA review date, totals) moved to `railHint`: the row's tooltip
 * and its accessible description — one hover or focus away, never gone.
 *
 * Every branch returns `null` when the number it needs is `undefined` — the
 * counts endpoint has not answered, is absent, or withheld the key. "0 open"
 * and "unknown" both render nothing now, but nothing here ever invents a 0.
 *
 * Returns a plain descriptor the rail renders:
 *   { kind:'text',  text }                          — tertiary 11px
 *   { kind:'score', score, tone }                   — 8px dot + number
 *   { kind:'clock', dueAt, startedAt, urgentBelowMs, badge, tone, suffix } — DeadlineClock rail (or a badge) + "4 open"
 * (`t` is the app translator; `fmt` formats a time/date for the locale.)
 */
import { countFor } from './data/useComplianceCounts';
import { toneOfScore } from '../../shared/statusTone';
import { DAY_MS, HOUR_MS } from '../../shared/deadlineMath';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The product's ROPA cadence (GDPR-Art30-ropa-reviewed fails after a year). */
const ROPA_REVIEW_MS = 365 * DAY_MS;

/**
 * The nominal window of each incident clock (counts `incidents.next_stage`),
 * so the rail clock picks hours or days the way the register row does: a
 * window under a week counts hours, a final report counts days.
 */
const INCIDENT_WINDOW_MS = Object.freeze({
    early_warning: 24 * HOUR_MS,
    customer_notice: 4 * HOUR_MS, // DORA: the contract's window, 4 h by default (incidentStore)
    authority: 72 * HOUR_MS,
    final_report: 14 * DAY_MS,
});

/** 'run 09:12' — always 24 h, as the artboard and the Dutch product locale write it. */
export function formatClock(iso, locale) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try { return new Intl.DateTimeFormat(locale || undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }
    catch { return d.toISOString().slice(11, 16); }
}

export function formatDay(iso, locale) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try { return new Intl.DateTimeFormat(locale || undefined, { day: 'numeric', month: 'short' }).format(d); }
    catch { return d.toISOString().slice(0, 10); }
}

/** The score a framework section shows in its rail row, or undefined. */
export function railScore(counts, frameworkId) {
    const s = countFor(counts, `frameworks.${frameworkId}.score`);
    return isNum(s) ? s : undefined;
}

/** A rail row's tooltip: the label, and the hint on a second line. */
export function railRowTitle(label, hint) {
    return hint ? `${label}\n${hint}` : label;
}

/** "{n} {state}" for a positive count, else nothing — the one rule. */
function countMeta(n, t, key, fallback) {
    return isNum(n) && n > 0 ? { kind: 'text', text: t(key, fallback, { n }) } : null;
}

/**
 * @param {object} section   a sections.js record
 * @param {object} counts    GET /counts body | null
 * @param {Function} t       translator
 * @param {{ locale?: string, now?: number, failing?: number }} [opts]
 *        `failing`: the open checks of a framework row — passed by the rail in
 *        its "Needs attention" view, where the row then reads "{n} to fix".
 */
export default function railMeta(section, counts, t, { now = Date.now(), failing = undefined } = {}) {
    if (!section) return null;
    const c = counts || null;
    if (section.regulation) {
        if (isNum(failing) && failing > 0) return { kind: 'text', text: t('compliance.rail_meta_failing', '{n} to fix', { n: failing }) };
        const score = railScore(c, section.id === 'iso' ? 'iso27001' : section.id);
        return score === undefined ? null : { kind: 'score', score, tone: toneOfScore(score) };
    }
    switch (section.id) {
        case 'frameworks':
            return countMeta(countFor(c, 'frameworks_summary.recently_in_force'), t, 'compliance.rail_meta_new', '{n} new');
        case 'dsr': {
            const open = countFor(c, 'dsr.open');
            if (!isNum(open) || open <= 0) return null;
            const overdue = countFor(c, 'dsr.overdue');
            return {
                kind: 'clock',
                // The rail clock for DSR is the overdue COUNT (artboard: timer glyph + "1"), not a running clock.
                badge: isNum(overdue) && overdue > 0 ? String(overdue) : null,
                tone: isNum(overdue) && overdue > 0 ? 'error' : null,
                suffix: t('compliance.rail_meta_open', '{n} open', { n: open }),
            };
        }
        case 'incidents': {
            const open = countFor(c, 'incidents.open');
            if (!isNum(open) || open <= 0) return null;
            const due = countFor(c, 'incidents.next_deadline_at');
            const dueMs = due ? new Date(due).getTime() : NaN;
            const suffix = t('compliance.rail_meta_open', '{n} open', { n: open });
            if (Number.isFinite(dueMs)) {
                // The shared DeadlineClock draws the number, so the rail rounds
                // exactly like the register row and the Deadlines card.
                const window = INCIDENT_WINDOW_MS[countFor(c, 'incidents.next_stage')] || INCIDENT_WINDOW_MS.authority;
                return {
                    kind: 'clock',
                    dueAt: due,
                    startedAt: new Date(dueMs - window).toISOString(),
                    urgentBelowMs: 24 * HOUR_MS,
                    badge: null,
                    tone: null,
                    suffix,
                    now,
                };
            }
            const hours = countFor(c, 'incidents.hours_left');
            return {
                kind: 'clock',
                badge: isNum(hours) ? t('compliance.clock_short_hours', '{hours} h', { hours: Math.max(0, Math.ceil(hours)) }) : null,
                tone: isNum(hours) ? (hours <= 0 ? 'error' : hours <= 24 ? 'warning' : 'success') : null,
                suffix,
                now,
            };
        }
        case 'vulnerabilities':
            return countMeta(countFor(c, 'incidents.vulnerabilities_open'), t, 'compliance.rail_meta_open', '{n} open');
        case 'ropa': {
            const ropa = countFor(c, 'ropa');
            if (!ropa || typeof ropa !== 'object') return null;
            const at = ropa.last_reviewed_at ? new Date(ropa.last_reviewed_at).getTime() : NaN;
            const overdue = !Number.isFinite(at) || now - at > ROPA_REVIEW_MS;
            return overdue ? { kind: 'text', text: t('compliance.rail_meta_review_due', 'review due') } : null;
        }
        case 'dpia':
            return countMeta(countFor(c, 'dpia.todo'), t, 'compliance.rail_meta_todo', '{n} to do');
        case 'risks':
            return countMeta(countFor(c, 'risks.high'), t, 'compliance.rail_meta_high', '{n} high');
        case 'soa':
            return countMeta(countFor(c, 'soa.todo'), t, 'compliance.rail_meta_to_decide', '{n} to decide');
        case 'policies':
            return countMeta(countFor(c, 'policies.review_due'), t, 'compliance.rail_meta_review_overdue', '{n} review overdue');
        case 'audits':
            return countMeta(countFor(c, 'audits.planned'), t, 'compliance.rail_meta_open', '{n} open');
        case 'training': {
            const done = countFor(c, 'training.done'); const total = countFor(c, 'training.total');
            if (!isNum(done) || !isNum(total) || total <= 0 || done >= total) return null;
            return { kind: 'text', text: t('compliance.rail_meta_acknowledged', '{done}/{total} acknowledged', { done, total }) };
        }
        case 'portability':
            return countMeta(countFor(c, 'portability.gaps'), t, 'compliance.rail_meta_gaps', '{n} gaps');
        default:
            // overview, access_log, settings, connectors: nothing to act on in the
            // row itself — their background figures are in railHint.
            return null;
    }
}

/**
 * The background text of a row — what the meta used to show and no longer
 * does (it is not an actionable count). The rail puts it in the row's `title`
 * and in an sr-only description (`aria-describedby`), so hovering or focusing
 * the row reads it. null when there is nothing to say.
 */
export function railHint(section, counts, t, { locale = undefined } = {}) {
    if (!section) return null;
    const c = counts || null;
    switch (section.id) {
        case 'overview': {
            const hhmm = formatClock(countFor(c, 'last_run.at'), locale);
            return hhmm ? t('compliance.rail_meta_run', 'run {time}', { time: hhmm }) : null;
        }
        case 'frameworks': {
            const cand = countFor(c, 'frameworks_summary.candidates');
            if (!isNum(cand)) return null;
            const recent = countFor(c, 'frameworks_summary.recently_in_force');
            return isNum(recent) && recent > 0
                ? t('compliance.rail_meta_candidates_recent', '{n} candidates · {m} just in force', { n: cand, m: recent })
                : t('compliance.rail_meta_candidates', '{n} candidates', { n: cand });
        }
        case 'ropa': {
            const day = formatDay(countFor(c, 'ropa.last_reviewed_at'), locale);
            return day ? t('compliance.rail_meta_reviewed', 'reviewed {date}', { date: day }) : null;
        }
        case 'risks': {
            const total = countFor(c, 'risks.total'); const high = countFor(c, 'risks.high');
            return isNum(total) && isNum(high) ? t('compliance.rail_meta_risks', '{n} · {high} high', { n: total, high }) : null;
        }
        case 'soa': {
            const approved = countFor(c, 'soa.approved'); const total = countFor(c, 'soa.total');
            return isNum(approved) && isNum(total) ? t('compliance.rail_meta_soa', '{approved}/{total} approved', { approved, total }) : null;
        }
        case 'settings':
            return t('compliance.rail_meta_settings', 'DPO · legal bases');
        case 'connectors': {
            const n = countFor(c, 'connectors.count');
            if (!isNum(n)) return null;
            const next = formatClock(countFor(c, 'connectors.next_sweep_at'), locale);
            return next ? t('compliance.rail_meta_connectors', '{n} · sweep {time}', { n, time: next }) : String(n);
        }
        default:
            return null;
    }
}

export { DAY_MS };
