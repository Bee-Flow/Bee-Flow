import { describe, it, expect } from 'vitest';
import railMeta, { formatClock, formatDay, railScore } from './railMeta';
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
    soa: { approved: 9, total: 93 },
    policies: { total: 6, review_due: 1 },
    audits: { planned: 1 },
    training: { done: 41, total: 44 },
    connectors: { count: 3, next_sweep_at: '2026-09-14T04:00:00Z' },
    evidence: { rows: 2053, chain_ok: true, algorithm: 'SHA-256' },
};

describe('railMeta — every branch, and undefined counts render nothing', () => {
    it('answers null for every section when counts are absent (except the static settings hint)', () => {
        for (const s of SECTIONS) {
            const m = railMeta(s, null, t);
            if (s.id === 'settings') expect(m).toEqual({ kind: 'text', text: 'DPO · legal bases' });
            else expect(m, s.id).toBeNull();
        }
    });

    it('answers null when counts is the nav-test [] mock or an empty object', () => {
        for (const s of SECTIONS.filter(x => x.id !== 'settings')) {
            expect(railMeta(s, [], t), s.id).toBeNull();
            expect(railMeta(s, {}, t), s.id).toBeNull();
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

    it('overview shows the last run time; frameworks the candidate count', () => {
        expect(railMeta(sectionById('overview'), FULL, t).text).toMatch(/^run \d{2}:\d{2}$/);
        expect(railMeta(sectionById('frameworks'), FULL, t).text).toBe('7 candidates · 2 just in force');
        expect(railMeta(sectionById('frameworks'), { frameworks_summary: { candidates: 7 } }, t).text).toBe('7 candidates');
    });

    it('registers: DSR overdue badge, incident hours, ropa date, dpia, risks, soa, policies, audits, training, connectors', () => {
        const dsr = railMeta(sectionById('dsr'), FULL, t);
        expect(dsr).toMatchObject({ kind: 'clock', badge: '1', tone: 'error', suffix: '4 open' });
        expect(railMeta(sectionById('dsr'), { dsr: { open: 4, overdue: 0 } }, t)).toMatchObject({ badge: null, tone: null, suffix: '4 open' });
        const inc = railMeta(sectionById('incidents'), FULL, t);
        expect(inc).toMatchObject({ kind: 'clock', badge: '41 h', tone: 'success', suffix: '1 open' });
        expect(railMeta(sectionById('incidents'), { incidents: { open: 1, hours_left: 3 } }, t).tone).toBe('warning');
        expect(railMeta(sectionById('incidents'), { incidents: { open: 1, hours_left: -2 } }, t).tone).toBe('error');
        expect(railMeta(sectionById('vulnerabilities'), FULL, t).text).toBe('0 open'); // a stated zero is a fact
        expect(railMeta(sectionById('ropa'), FULL, t).text).toMatch(/^reviewed /);
        expect(railMeta(sectionById('dpia'), FULL, t).text).toBe('2 to do');
        expect(railMeta(sectionById('risks'), FULL, t).text).toBe('12 · 2 high');
        expect(railMeta(sectionById('soa'), FULL, t).text).toBe('9/93 approved');
        expect(railMeta(sectionById('policies'), FULL, t).text).toBe('6 · 1 review');
        expect(railMeta(sectionById('policies'), { policies: { total: 6, review_due: 0 } }, t).text).toBe('6');
        expect(railMeta(sectionById('audits'), FULL, t).text).toBe('1 planned');
        expect(railMeta(sectionById('training'), FULL, t).text).toBe('41/44');
        expect(railMeta(sectionById('connectors'), FULL, t).text).toMatch(/^3 · sweep \d{2}:\d{2}$/);
        expect(railMeta(sectionById('access_log'), FULL, t)).toBeNull();
    });

    it('date helpers survive junk', () => {
        expect(formatClock(null)).toBeNull();
        expect(formatClock('not a date')).toBeNull();
        expect(formatDay(undefined)).toBeNull();
        expect(formatClock('2026-09-14T07:12:00Z')).toMatch(/\d{2}:\d{2}/);
    });
});
