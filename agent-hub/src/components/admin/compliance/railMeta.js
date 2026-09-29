/**
 * railMeta — the right-hand meta of every rail row ('Compliance Rail.dc.html').
 *
 * One function, one switch, one rule: every branch returns `null` when the
 * number it needs is `undefined` — the counts endpoint has not answered, is
 * absent, or withheld the key. A row then shows its label and nothing else.
 * "0 open" is a fact the server stated; a blank is the absence of one. The
 * two must never look alike, which is why nothing here ever defaults to 0.
 *
 * Returns a plain descriptor the rail renders:
 *   { kind:'text',  text }                          — tertiary 11px
 *   { kind:'score', score, tone }                   — 8px dot + number
 *   { kind:'clock', dueAt, startedAt, state, pct, urgentBelowMs, tone, suffix } — DeadlineClock rail + "4 open"
 * (`t` is the app translator; `fmt` formats a time/date for the locale.)
 */
import { countFor } from './data/useComplianceCounts';
import { toneOfScore } from '../../shared/statusTone';
import { DAY_MS, HOUR_MS } from '../../shared/deadlineMath';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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

export default function railMeta(section, counts, t, { locale = undefined, now = Date.now() } = {}) {
    if (!section) return null;
    const c = counts || null;
    switch (section.id) {
        case 'overview': {
            const at = countFor(c, 'last_run.at');
            const hhmm = formatClock(at, locale);
            return hhmm ? { kind: 'text', text: t('compliance.rail_meta_run', 'run {time}', { time: hhmm }) } : null;
        }
        case 'gdpr': case 'aia': case 'iso':
        case 'nis2': case 'cra': case 'data_act': case 'pld': case 'eaa': case 'dora': case 'machinery': case 'custom': {
            const fwId = section.id === 'iso' ? 'iso27001' : section.id;
            const score = railScore(c, fwId);
            return score === undefined ? null : { kind: 'score', score, tone: toneOfScore(score) };
        }
        case 'frameworks': {
            const cand = countFor(c, 'frameworks_summary.candidates');
            const recent = countFor(c, 'frameworks_summary.recently_in_force');
            if (!isNum(cand)) return null;
            return {
                kind: 'text',
                text: isNum(recent) && recent > 0
                    ? t('compliance.rail_meta_candidates_recent', '{n} candidates · {m} just in force', { n: cand, m: recent })
                    : t('compliance.rail_meta_candidates', '{n} candidates', { n: cand }),
            };
        }
        case 'dsr': {
            const open = countFor(c, 'dsr.open');
            if (!isNum(open)) return null;
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
            if (!isNum(open)) return null;
            const due = countFor(c, 'incidents.next_deadline_at');
            const hours = countFor(c, 'incidents.hours_left');
            return {
                kind: 'clock',
                dueAt: due || null,
                startedAt: due ? new Date(new Date(due).getTime() - 72 * HOUR_MS).toISOString() : null,
                urgentBelowMs: 24 * HOUR_MS,
                badge: isNum(hours) ? t('compliance.clock_short_hours', '{hours} h', { hours: Math.max(0, Math.ceil(hours)) }) : null,
                tone: isNum(hours) ? (hours <= 0 ? 'error' : hours <= 24 ? 'warning' : 'success') : null,
                suffix: t('compliance.rail_meta_open', '{n} open', { n: open }),
                now,
            };
        }
        case 'vulnerabilities': {
            const open = countFor(c, 'incidents.vulnerabilities_open');
            return isNum(open) ? { kind: 'text', text: t('compliance.rail_meta_open', '{n} open', { n: open }) } : null;
        }
        case 'ropa': {
            const at = countFor(c, 'ropa.last_reviewed_at');
            const day = formatDay(at, locale);
            return day ? { kind: 'text', text: t('compliance.rail_meta_reviewed', 'reviewed {date}', { date: day }) } : null;
        }
        case 'dpia': {
            const todo = countFor(c, 'dpia.todo');
            return isNum(todo) ? { kind: 'text', text: t('compliance.rail_meta_todo', '{n} to do', { n: todo }) } : null;
        }
        case 'risks': {
            const total = countFor(c, 'risks.total');
            if (!isNum(total)) return null;
            const high = countFor(c, 'risks.high');
            return { kind: 'text', text: isNum(high) ? t('compliance.rail_meta_risks', '{n} · {high} high', { n: total, high }) : String(total) };
        }
        case 'soa': {
            const approved = countFor(c, 'soa.approved'); const total = countFor(c, 'soa.total');
            return isNum(approved) && isNum(total) ? { kind: 'text', text: t('compliance.rail_meta_soa', '{approved}/{total} approved', { approved, total }) } : null;
        }
        case 'policies': {
            const total = countFor(c, 'policies.total');
            if (!isNum(total)) return null;
            const due = countFor(c, 'policies.review_due');
            return { kind: 'text', text: isNum(due) && due > 0 ? t('compliance.rail_meta_policies_due', '{n} · {due} review', { n: total, due }) : String(total) };
        }
        case 'audits': {
            const planned = countFor(c, 'audits.planned');
            return isNum(planned) ? { kind: 'text', text: t('compliance.rail_meta_planned', '{n} planned', { n: planned }) } : null;
        }
        case 'training': {
            const done = countFor(c, 'training.done'); const total = countFor(c, 'training.total');
            return isNum(done) && isNum(total) ? { kind: 'text', text: `${done}/${total}` } : null;
        }
        case 'portability': {
            const gaps = countFor(c, 'portability.gaps');
            return isNum(gaps) ? { kind: 'text', text: t('compliance.rail_meta_gaps', '{n} gaps', { n: gaps }) } : null;
        }
        case 'settings':
            return { kind: 'text', text: t('compliance.rail_meta_settings', 'DPO · legal bases') };
        case 'connectors': {
            const n = countFor(c, 'connectors.count');
            if (!isNum(n)) return null;
            const next = formatClock(countFor(c, 'connectors.next_sweep_at'), locale);
            return { kind: 'text', text: next ? t('compliance.rail_meta_connectors', '{n} · sweep {time}', { n, time: next }) : String(n) };
        }
        default:
            return null;
    }
}

export { DAY_MS };
