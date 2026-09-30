/** The hub's pure parts: row metas, sections, navigation, checks and the settings form. */

import { checkKey, checkMeta, checkTitle, findCheck, isOpenCheck, sortChecks } from './checks';
import { emptyCounts, formatClock, formatDay, headlineOfScore, hubSubtitle, rowMeta, toneOfScore } from './counts';
import { attentionTarget, recordRoute, sectionRoute, targetRoute } from './navigation';
import { frameworkIdOf, sectionById, sectionForRegulation, sectionsInGroup, visibleSections } from './sections';
import { contactCount, normaliseSettings, settingsErrors, settingsPatch } from './settings';
import { readCounts } from '../api/readers';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));

const COUNTS = readCounts({
    attention_open: 7,
    last_run: { at: '2026-09-01T09:12:00', interval_hours: 6 },
    frameworks: { gdpr: { score: 91 }, iso27001: { score: 55 }, nis2: { score: null } },
    frameworks_summary: { candidates: 4, recently_in_force: 1 },
    dsr: { open: 3, overdue: 1 },
    incidents: { open: 2, hours_left: 20, vulnerabilities_open: 1 },
    ropa: { last_reviewed_at: '2026-08-01T00:00:00Z' },
    dpia: { todo: 2 },
    risks: { total: 9, high: 2 },
    soa: { approved: 40, total: 93 },
    policies: { total: 5, review_due: 1 },
    audits: { planned: 1 },
    training: { done: 3, total: 4 },
    connectors: { count: 2, next_sweep_at: null },
    onboarded: true,
});

const meta = (id: string) => rowMeta(sectionById(id)!, COUNTS, t);

describe('counts and row metas', () => {
    it('reads what the server stated and nothing else', () => {
        expect(readCounts([])).toEqual(emptyCounts());
        expect(COUNTS.scores).toEqual({ gdpr: 91, iso27001: 55, nis2: null });
        expect(COUNTS.onboarded).toBe(true);
    });

    it('writes each row the way the web rail does', () => {
        expect(meta('gdpr')).toEqual({ text: '91', tone: 'success' });
        expect(meta('iso')).toEqual({ text: '55', tone: 'error' });
        expect(meta('nis2')).toBeNull();
        expect(meta('frameworks')?.text).toBe('4 candidates · 1 just in force');
        expect(meta('dsr')).toEqual({ text: '1 · 3 open', tone: 'error' });
        expect(meta('incidents')).toEqual({ text: '20 h · 2 open', tone: 'warning' });
        expect(meta('vulnerabilities')?.text).toBe('1 open');
        expect(meta('ropa')?.text).toMatch(/^reviewed /);
        expect(meta('dpia')?.text).toBe('2 to do');
        expect(meta('risks')?.text).toBe('9 · 2 high');
        expect(meta('soa')?.text).toBe('40/93 approved');
        expect(meta('policies')?.text).toBe('5 · 1 review');
        expect(meta('audits')?.text).toBe('1 planned');
        expect(meta('training')?.text).toBe('3/4');
        expect(meta('connectors')?.text).toBe('2');
        expect(meta('access_log')).toBeNull();
        expect(rowMeta(sectionById('settings')!, null, t)?.text).toBe('DPO · legal bases');
        expect(rowMeta(sectionById('dsr')!, null, t)).toBeNull();
    });

    it('says the last run and the open count under the title', () => {
        expect(hubSubtitle(COUNTS, t)).toBe('run today 09:12 · 7 open');
        expect(hubSubtitle(emptyCounts(), t)).toBeNull();
        expect(formatClock('nope')).toBeNull();
        expect(formatDay(null)).toBeNull();
    });

    it('tones a score and heads it', () => {
        expect([toneOfScore(90), toneOfScore(70), toneOfScore(10), toneOfScore(null)]).toEqual(['success', 'warning', 'error', 'neutral']);
        expect(headlineOfScore(null, t)).toBe('Score after the first run');
        expect(headlineOfScore(90, t)).toBe('You are in good shape');
    });
});

describe('sections', () => {
    it('resolves ids and the old aliases', () => {
        expect(sectionById('iso_soa')?.id).toBe('soa');
        expect(sectionById(' dsr ')?.id).toBe('dsr');
        expect(sectionById('nope')).toBeNull();
        expect(frameworkIdOf(sectionById('iso')!)).toBe('iso27001');
        expect(frameworkIdOf(sectionById('vulnerabilities')!)).toBe('cra');
        expect(sectionForRegulation('ISO27001')).toBe('iso');
        expect(sectionForRegulation('??')).toBe('overview');
    });

    it('shows an optional row once its framework is scored or enabled', () => {
        const ids = (s: ReturnType<typeof sectionsInGroup>) => s.map((x) => x.id);
        const frameworks = sectionsInGroup('frameworks');
        expect(ids(visibleSections(frameworks, new Set(), new Set()))).toEqual(['gdpr', 'aia', 'iso', 'frameworks']);
        expect(ids(visibleSections(frameworks, new Set(['nis2']), new Set(['machinery'])))).toContain('machinery');
        expect(ids(visibleSections(sectionsInGroup('registers'), new Set(), new Set(['cra'])))).toContain('vulnerabilities');
    });
});

describe('navigation', () => {
    it('maps the server target onto the phone routes', () => {
        const item = { source: 'register', code: 'x', id: 'register:x', meta: { frameworks: [] }, action: { target: '/app/admin/compliance/incidents/12' } };
        expect(attentionTarget(item)).toEqual({ section: 'incidents', id: '12' });
        expect(targetRoute(attentionTarget(item))).toBe('/org/compliance/incidents/12');
        const check = { source: 'check', code: 'GDPR-Art30', id: 'check:x', meta: { frameworks: [{ regulation: 'GDPR' }] }, action: { target: 'https://elsewhere' } };
        expect(attentionTarget(check)).toEqual({ section: 'gdpr', id: 'GDPR-Art30' });
        expect(targetRoute({ section: 'iso_audit', id: '3' })).toBe('/org/compliance/audits/3');
        expect(targetRoute({ section: 'dsr', id: null })).toBe('/org/compliance/dsr');
        expect(targetRoute({ section: 'overview', id: null })).toBe('/org/compliance');
        expect(sectionRoute('soa')).toBe('/org/compliance/soa');
        expect(recordRoute('soa', 'A.5.1')).toBe('/org/compliance/soa/A.5.1');
    });
});

describe('checks', () => {
    const rows = [
        { check_id: 'B', status: 'pass', severity: 'low', scope_id: null, title: null, titleKey: 'k.b', article: '5' },
        { check_id: 'A', status: 'fail', severity: 'high', scope_id: 'agent1', title: null, titleKey: null, article: null },
        { check_id: 'C', status: 'warn', severity: 'critical', scope_id: null, title: 'Own item', titleKey: null, article: null },
    ] as unknown as Parameters<typeof sortChecks>[0];

    it('keys per scope, finds by key or id, and sorts the open ones first', () => {
        expect(rows.map(checkKey)).toEqual(['B', 'A~agent1', 'C']);
        expect(findCheck(rows, 'A')?.scope_id).toBe('agent1');
        expect(sortChecks(rows).map((c) => c.check_id)).toEqual(['A', 'C', 'B']);
        expect(rows.filter(isOpenCheck).length).toBe(2);
        expect(rows.map((c) => checkTitle(c, t))).toEqual(['B', 'A', 'Own item']);
        expect(checkMeta(rows[0]!, t)).toBe('Art. 5 · low');
    });
});

describe('the settings form', () => {
    const stored = { dpo_name: 'Dee', legal_bases: ['consent'], sso_enforces_mfa: true, nis2_registered_at: '2026-01-02T00:00:00Z', incident_customer_contacts: [{ name: 'X' }, 'junk'] };

    it('sends only the changed columns, typed as their column', () => {
        const base = normaliseSettings(stored);
        expect(base.nis2_registered_at).toBe('2026-01-02');
        expect(settingsPatch(base, base)).toEqual({});
        expect(settingsPatch(base, { ...base, dpo_name: ' ', legal_bases: ['consent', 'contract'], notice_period_days: '60', sso_enforces_mfa: false })).toEqual({
            dpo_name: null,
            legal_bases: ['consent', 'contract'],
            notice_period_days: 60,
            sso_enforces_mfa: false,
        });
        expect(base).not.toHaveProperty('incident_customer_contacts');
        expect(contactCount(stored, 'incident_customer_contacts')).toBe(1);
    });

    it('holds back a number or a date it cannot send', () => {
        const base = normaliseSettings({});
        expect(settingsErrors({ ...base, notice_period_days: 'soon', support_end_date: '1 Jan' })).toEqual(['support_end_date', 'notice_period_days']);
    });
});
