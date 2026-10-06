import { describe, it, expect } from 'vitest';
import railMeta, { formatClock, formatDay, railScore, railHint } from './railMeta';
import { sectionById, SECTIONS } from './sections';

const t = (key, fallback, vars) => {
    let s = fallback || key;
    for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, String(v));
    return s;
};

const FULL = {
    attention_open: 7,
    last_run: { at: '2026-09-14T07:12:00Z', interval_hours: 6 },
    frameworks: { gdpr: { score: 79, tone: 'warn' }, aia: { score: 58 }, iso27001: { score: 88 }, cra: { score: null } },
    frameworks_summary: { active: 3, candidates: 7, recently_in_force: 2, locked: 2 },
    dsr: { open: 4, overdue: 1, due_soon: 1 },
    incidents: { open: 1, next_deadline_at: '2026-09-16T09:04:00Z', hours_left: 41, vulnerabilities_open: 0 },
    ropa: { last_reviewed_at: '2026-09-02T10:00:00Z' },
    dpia: { todo: 2 },
    risks: { total: 12, high: 2 },
    soa: { approved: 9, total: 93, todo: 61 },
    policies: { total: 6, review_due: 1 },
    audits: { planned: 1 },
    training: { done: 41, total: 44 },
    connectors: { count: 3, next_sweep_at: '2026-09-14T04:00:00Z' },
    evidence: { rows: 2053, chain_ok: true, algorithm: 'SHA-256' },
};

const NOW = Date.parse('2026-09-14T08:00:00Z');

describe('railMeta — one actionable count per row, nothing when clean or unknown', () => {
    it('answers null for every section when counts are absent', () => {
        for (const s of SECTIONS) expect(railMeta(s, null, t, { now: NOW }), s.id).toBeNull();
    });

    it('answers null when counts is the nav-test [] mock or an empty object', () => {
        for (const s of SECTIONS) {
            expect(railMeta(s, [], t, { now: NOW }), s.id).toBeNull();
            expect(railMeta(s, {}, t, { now: NOW }), s.id).toBeNull();
        }
    });

    it('framework rows show the score with its tone; a null score shows nothing', () => {
        expect(railMeta(sectionById('gdpr'), FULL, t)).toEqual({ kind: 'score', score: 79, tone: 'warning' });
        expect(railMeta(sectionById('aia'), FULL, t)).toEqual({ kind: 'score', score: 58, tone: 'error' });
        expect(railMeta(sectionById('iso'), FULL, t)).toEqual({ kind: 'score', score: 88, tone: 'success' });
        expect(railMeta(sectionById('cra'), FULL, t)).toBeNull();
        expect(railMeta(sectionById('nis2'), FULL, t)).toBeNull();
        expect(railScore(FULL, 'iso27001')).toBe(88);
        expect(railScore(FULL, 'cra')).toBeUndefined();
    });

    it('in the attention view a framework row says how many checks are open', () => {
        expect(railMeta(sectionById('gdpr'), FULL, t, { failing: 2 })).toEqual({ kind: 'text', text: '2 to fix' });
        // 0 open checks: back to the score.
        expect(railMeta(sectionById('gdpr'), FULL, t, { failing: 0 })).toEqual({ kind: 'score', score: 79, tone: 'warning' });
    });

    it('the new count wording: "{n} {state}"', () => {
        const meta = (id, counts = FULL) => railMeta(sectionById(id), counts, t, { now: NOW })?.text;
        expect(meta('frameworks')).toBe('2 new');
        expect(meta('risks')).toBe('2 high');
        expect(meta('soa')).toBe('61 to decide');
        expect(meta('policies')).toBe('1 review overdue');
        expect(meta('audits')).toBe('1 open');
        expect(meta('training')).toBe('41/44 acknowledged');
        expect(meta('dpia')).toBe('2 to do');
        expect(meta('portability', { portability: { gaps: 3 } })).toBe('3 gaps');
        expect(meta('vulnerabilities', { incidents: { vulnerabilities_open: 2 } })).toBe('2 open');
    });

    it('clean rows return no meta (a stated zero is clean, not a number to show)', () => {
        const clean = {
            frameworks_summary: { candidates: 7, recently_in_force: 0 },
            dsr: { open: 0, overdue: 0 }, incidents: { open: 0, vulnerabilities_open: 0 },
            ropa: { last_reviewed_at: '2026-09-02T10:00:00Z' }, dpia: { todo: 0 },
            risks: { total: 12, high: 0 }, soa: { approved: 93, total: 93, todo: 0 },
            policies: { total: 6, review_due: 0 }, audits: { planned: 0 }, training: { done: 44, total: 44 },
            portability: { gaps: 0 }, connectors: { count: 3 }, last_run: { at: '2026-09-14T07:12:00Z' },
        };
        for (const s of SECTIONS.filter(x => !x.regulation)) expect(railMeta(s, clean, t, { now: NOW }), s.id).toBeNull();
    });

    it('Settings, Overview, Connectors and Access log carry no meta; ROPA only when its review is due', () => {
        for (const id of ['settings', 'overview', 'connectors', 'access_log']) expect(railMeta(sectionById(id), FULL, t, { now: NOW }), id).toBeNull();
        expect(railMeta(sectionById('ropa'), FULL, t, { now: NOW })).toBeNull();
        expect(railMeta(sectionById('ropa'), { ropa: { last_reviewed_at: '2025-08-01T00:00:00Z' } }, t, { now: NOW }).text).toBe('review due');
        // Never reviewed: due as well. Absent key: unknown → nothing.
        expect(railMeta(sectionById('ropa'), { ropa: { last_reviewed_at: null } }, t, { now: NOW }).text).toBe('review due');
        expect(railMeta(sectionById('ropa'), { dpia: { todo: 1 } }, t, { now: NOW })).toBeNull();
    });

    it('DSR keeps its overdue badge beside "{n} open"', () => {
        expect(railMeta(sectionById('dsr'), FULL, t)).toMatchObject({ kind: 'clock', badge: '1', tone: 'error', suffix: '4 open' });
        expect(railMeta(sectionById('dsr'), { dsr: { open: 4, overdue: 0 } }, t)).toMatchObject({ badge: null, tone: null, suffix: '4 open' });
    });

    it('incidents: the badge is null whenever next_deadline_at exists, so DeadlineClock does the rounding', () => {
        const inc = railMeta(sectionById('incidents'), FULL, t, { now: NOW });
        expect(inc).toMatchObject({ kind: 'clock', badge: null, dueAt: '2026-09-16T09:04:00Z', suffix: '1 open' });
        // Authority (72 h) is the default window: an hours clock.
        expect(Date.parse(inc.dueAt) - Date.parse(inc.startedAt)).toBe(72 * 3600_000);
        // A DORA customer notice is a short window; a final report counts days.
        const notice = railMeta(sectionById('incidents'), { incidents: { open: 1, next_deadline_at: '2026-09-14T09:00:00Z', next_stage: 'customer_notice', hours_left: 1 } }, t);
        expect(notice.badge).toBeNull();
        expect(Date.parse(notice.dueAt) - Date.parse(notice.startedAt)).toBe(4 * 3600_000);
        const final = railMeta(sectionById('incidents'), { incidents: { open: 1, next_deadline_at: '2026-09-24T09:00:00Z', next_stage: 'final_report' } }, t);
        expect(Date.parse(final.dueAt) - Date.parse(final.startedAt)).toBe(14 * 86_400_000);
    });

    it('incidents without a due date fall back to the hours badge', () => {
        expect(railMeta(sectionById('incidents'), { incidents: { open: 1, hours_left: 41 } }, t)).toMatchObject({ badge: '41 h', tone: 'success', suffix: '1 open' });
        expect(railMeta(sectionById('incidents'), { incidents: { open: 1, hours_left: 3 } }, t).tone).toBe('warning');
        expect(railMeta(sectionById('incidents'), { incidents: { open: 1, hours_left: -2 } }, t).tone).toBe('error');
    });
});

describe('railHint — the former static meta, for the tooltip and the description', () => {
    it('keeps every background figure the meta dropped', () => {
        const hint = (id) => railHint(sectionById(id), FULL, t);
        expect(hint('settings')).toBe('DPO · legal bases');
        expect(hint('overview')).toMatch(/^run \d{2}:\d{2}$/);
        expect(hint('connectors')).toMatch(/^3 · sweep \d{2}:\d{2}$/);
        expect(hint('ropa')).toMatch(/^reviewed /);
        expect(hint('frameworks')).toBe('7 candidates · 2 just in force');
        expect(hint('risks')).toBe('12 · 2 high');
        expect(hint('soa')).toBe('9/93 approved');
        expect(hint('gdpr')).toBeNull();
        expect(hint('dsr')).toBeNull();
    });

    it('is null when the figure is unknown — except the static settings line', () => {
        for (const s of SECTIONS) {
            const h = railHint(s, null, t);
            if (s.id === 'settings') expect(h).toBe('DPO · legal bases');
            else expect(h, s.id).toBeNull();
        }
    });
});

describe('railMeta helpers', () => {
    it('date helpers survive junk', () => {
        expect(formatClock(null)).toBeNull();
        expect(formatClock('not a date')).toBeNull();
        expect(formatDay(undefined)).toBeNull();
        expect(formatClock('2026-09-14T07:12:00Z')).toMatch(/\d{2}:\d{2}/);
    });
});
