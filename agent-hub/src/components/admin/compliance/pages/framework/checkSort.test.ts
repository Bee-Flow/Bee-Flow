import { describe, it, expect } from 'vitest';
import {
    belongsToRegulation, checksForRegulation, otherFrameworkRefs, articleForRegulation, articleNumber, articleKey,
    sortChecks, filterByStatus, countByStatus, matchesSearch, resolveRemediation, canFollow, autoFixCount,
    formatRunAt, shortHash, frameworkIdOf, isOpen, rowKeyOf, focusRowKey, subjectLabel,
} from './checkSort';
import { partial, malformed, stub } from '@/test/mocks';

const c = (check_id: string, status: number, severity: string, article: string, extra = {}) => ({ check_id, status, severity, article, regulation: 'GDPR', ...extra });

const LIST = [
    c('GDPR-Art32-enc', stub<Parameters<typeof c>[1]>('pass'), 'critical', '32'),
    c('GDPR-Art5-min', stub<Parameters<typeof c>[1]>('warn'), 'low', '5(1)(c)'),
    c('GDPR-Art33-breach', stub<Parameters<typeof c>[1]>('fail'), 'high', '33', { frameworks: [{ regulation: 'GDPR', ref: '33' }, { regulation: 'ISO27001', ref: 'A.5.24' }] }),
    c('GDPR-Art13-notice', stub<Parameters<typeof c>[1]>('fail'), 'critical', '13'),
    c('GDPR-Art28-dpa', stub<Parameters<typeof c>[1]>('not_applicable'), 'medium', '28'),
    c('GDPR-Art30-ropa', stub<Parameters<typeof c>[1]>('warn'), 'high', '30'),
];

describe('checkSort — membership', () => {
    it('a check belongs to its home regulation and to every framework it is tagged for', () => {
        const breach = LIST[2];
        expect(belongsToRegulation(stub<Parameters<typeof belongsToRegulation>[0]>(breach), 'GDPR')).toBe(true);
        expect(belongsToRegulation(stub<Parameters<typeof belongsToRegulation>[0]>(breach), 'ISO27001')).toBe(true);
        expect(belongsToRegulation(stub<Parameters<typeof belongsToRegulation>[0]>(breach), 'AIA')).toBe(false);
        expect(checksForRegulation(stub<Parameters<typeof checksForRegulation>[0]>(LIST), 'ISO27001').map((x) => x.check_id)).toEqual(['GDPR-Art33-breach']);
        expect(checksForRegulation(null, 'GDPR')).toEqual([]);
    });

    it('otherFrameworkRefs lists the OTHER ledgers only, deduplicated, home article included when the page is not home', () => {
        const breach = LIST[2];
        expect(otherFrameworkRefs(stub<Parameters<typeof otherFrameworkRefs>[0]>(breach), 'GDPR')).toEqual([{ regulation: 'ISO27001', ref: 'A.5.24' }]);
        expect(otherFrameworkRefs(stub<Parameters<typeof otherFrameworkRefs>[0]>(breach), 'ISO27001')).toEqual([{ regulation: 'GDPR', ref: '33' }]);
        expect(otherFrameworkRefs(stub<Parameters<typeof otherFrameworkRefs>[0]>(LIST[0]), 'GDPR')).toEqual([]);
    });

    it('articleForRegulation shows the tagged ref on a foreign page and the home article at home', () => {
        expect(articleForRegulation(stub<Parameters<typeof articleForRegulation>[0]>(LIST[2]), 'ISO27001')).toBe('A.5.24');
        expect(articleForRegulation(stub<Parameters<typeof articleForRegulation>[0]>(LIST[2]), 'GDPR')).toBe('33');
        expect(articleNumber('A.8.24')).toBe(8);
        expect(articleNumber('5(1)(c)')).toBe(5);
        expect(Number.isNaN(articleNumber('—'))).toBe(true);
        expect(articleKey('A.5.24')).toEqual([5, 24]);
        // Segment-wise: A.5.9 comes before A.5.24 (a float compare would invert them).
        const iso = [c('x', stub<Parameters<typeof c>[1]>('pass'), 'low', 'A.5.24'), c('y', stub<Parameters<typeof c>[1]>('pass'), 'low', 'A.5.9'), c('z', stub<Parameters<typeof c>[1]>('pass'), 'low', 'A.5.10')];
        expect(sortChecks(stub<Parameters<typeof sortChecks>[0]>(iso), 'by_article', 'GDPR').map((x) => x.article)).toEqual(['A.5.9', 'A.5.10', 'A.5.24']);
    });
});

describe('checkSort — order and filters', () => {
    it('by_status: fail → warn → pass → n/a, severity inside a band, then article', () => {
        const ids = sortChecks(stub<Parameters<typeof sortChecks>[0]>(LIST), 'by_status', 'GDPR').map((x) => x.check_id);
        expect(ids).toEqual([
            'GDPR-Art13-notice',   // fail critical
            'GDPR-Art33-breach',   // fail high
            'GDPR-Art30-ropa',     // warn high
            'GDPR-Art5-min',       // warn low
            'GDPR-Art32-enc',      // pass
            'GDPR-Art28-dpa',      // n/a
        ]);
    });

    it('by_article: numeric article order regardless of status; unknown mode falls back to by_status', () => {
        const ids = sortChecks(stub<Parameters<typeof sortChecks>[0]>(LIST), 'by_article', 'GDPR').map((x) => x.article);
        expect(ids).toEqual(['5(1)(c)', '13', '28', '30', '32', '33']);
        expect(sortChecks(stub<Parameters<typeof sortChecks>[0]>(LIST), 'nonsense', 'GDPR')[0].check_id).toBe('GDPR-Art13-notice');
        expect(sortChecks(stub<Parameters<typeof sortChecks>[0]>(LIST), 'by_article', 'GDPR')).not.toBe(LIST); // a copy
    });

    it('pills filter by status and count every band; `all` is the whole list', () => {
        expect(countByStatus(stub<Parameters<typeof countByStatus>[0]>(LIST))).toEqual({ all: 6, fail: 2, warn: 2, pass: 1, not_applicable: 1 });
        expect(filterByStatus(stub<Parameters<typeof filterByStatus>[0]>(LIST), 'warn').map((x) => x.check_id)).toEqual(['GDPR-Art5-min', 'GDPR-Art30-ropa']);
        expect(filterByStatus(stub<Parameters<typeof filterByStatus>[0]>(LIST), 'all')).toHaveLength(6);
        expect(isOpen('fail')).toBe(true); expect(isOpen('warn')).toBe(true); expect(isOpen('pass')).toBe(false);
    });

    it('search matches the translated title, id, article, details and tagged refs, case-insensitively', () => {
        const titleOf = (x: { check_id: unknown }) => (x.check_id === 'GDPR-Art33-breach' ? 'Breach detection' : '');
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(LIST[2]), 'BREACH DET', stub<Parameters<typeof matchesSearch>[2]>(titleOf))).toBe(true);
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(LIST[2]), 'a.5.24')).toBe(true);
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(LIST[0]), '32')).toBe(true);
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(LIST[0]), 'nothing here')).toBe(false);
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(LIST[0]), '   ')).toBe(true);
    });
});

describe('checkSort — actions', () => {
    it('resolveRemediation classifies settings, a compliance section (aliases resolved) and an admin escape', () => {
        expect(resolveRemediation('admin/compliance/settings')).toMatchObject({ kind: 'settings', sectionId: 'settings' });
        expect(resolveRemediation('admin/compliance/ropa')).toMatchObject({ kind: 'section', sectionId: 'ropa' });
        expect(resolveRemediation('/admin/compliance/iso_connectors')).toMatchObject({ kind: 'section', sectionId: 'connectors' });
        expect(resolveRemediation('admin/compliance/dsr/req-1')).toMatchObject({ kind: 'section', sectionId: 'dsr', subId: 'req-1' });
        expect(resolveRemediation('admin/monitoring/activity')).toEqual({ kind: 'external', path: 'admin/monitoring/activity' });
        expect(resolveRemediation('admin/compliance/does-not-exist')).toMatchObject({ kind: 'external' });
        expect(resolveRemediation(null)).toBeNull();
        expect(resolveRemediation('')).toBeNull();
    });

    it('canFollow needs navigate for sections and onNavigate for escapes', () => {
        const nav = () => {};
        expect(canFollow({ kind: 'section' }, { navigate: nav })).toBe(true);
        expect(canFollow({ kind: 'settings' }, {})).toBe(false);
        expect(canFollow({ kind: 'external' }, { navigate: nav })).toBe(false);
        expect(canFollow({ kind: 'external' }, { navigate: nav, onNavigate: nav })).toBe(true);
        expect(canFollow(null, { navigate: nav })).toBe(false);
    });

    it('autoFixCount reads the affected list, never invents a zero', () => {
        expect(autoFixCount(partial<Parameters<typeof autoFixCount>[0]>({ evidence: { missing_disclosure: [{ id: 'a' }, { id: 'b' }] } }))).toBe(2);
        expect(autoFixCount(partial<Parameters<typeof autoFixCount>[0]>({ auto_fix_count: 7 }))).toBe(7);
        expect(autoFixCount(partial<Parameters<typeof autoFixCount>[0]>({ evidence: { other: 1 } }))).toBeNull();
        expect(autoFixCount(null)).toBeNull();
    });
});

describe('checkSort — formatting', () => {
    it('formatRunAt: HH:mm today, short date otherwise, year only when it differs, null when unknown', () => {
        const now = new Date(2026, 8, 14, 15, 0).getTime();
        expect(formatRunAt(new Date(2026, 8, 14, 9, 5), { now, locale: 'en-GB' })).toBe('09:05');
        expect(formatRunAt(new Date(2026, 7, 2, 9, 5), { now, locale: 'en-GB' })).toMatch(/^2 Aug/);
        expect(formatRunAt(new Date(2025, 11, 2), { now, locale: 'en-GB' })).toMatch(/25$/);
        expect(formatRunAt(null, { now })).toBeNull();
        expect(formatRunAt('garbage', { now })).toBeNull();
    });

    it('shortHash trims to 12 hex characters and strips a sha256: prefix; frameworkIdOf lowercases the code', () => {
        expect(shortHash('sha256:abcdef0123456789ff')).toBe('abcdef012345');
        expect(shortHash('')).toBeNull();
        expect(frameworkIdOf('ISO27001')).toBe('iso27001');
        expect(frameworkIdOf('DATA_ACT')).toBe('data_act');
        expect(frameworkIdOf(null)).toBeNull();
    });
});

describe('checkSort — one row per subject', () => {
    const dpia = (scope_id: string, status: number, evidence = {}) => ({ check_id: 'GDPR-Art35-dpia-high-risk', scope_id, status, evidence });

    it('rowKeyOf is check + scope, with an empty scope for a global check', () => {
        expect(rowKeyOf(malformed<Parameters<typeof rowKeyOf>[0]>(dpia('agent_claims', stub<Parameters<typeof dpia>[1]>('fail'))))).toBe('GDPR-Art35-dpia-high-risk:agent_claims');
        expect(rowKeyOf(partial<Parameters<typeof rowKeyOf>[0]>({ check_id: 'GDPR-Art32-enc', scope_id: null }))).toBe('GDPR-Art32-enc:');
        expect(rowKeyOf(partial<Parameters<typeof rowKeyOf>[0]>({ check_id: 'GDPR-Art32-enc' }))).toBe('GDPR-Art32-enc:');
    });

    it('focusRowKey takes a row key exactly, and a bare check id as the first row of that check', () => {
        const list = [dpia('agent_claims', stub<Parameters<typeof dpia>[1]>('fail')), dpia('agent_intake', stub<Parameters<typeof dpia>[1]>('pass')), { check_id: 'GDPR-Art32-enc', scope_id: null }];
        expect(focusRowKey(malformed<Parameters<typeof focusRowKey>[0]>(list), 'GDPR-Art35-dpia-high-risk:agent_intake')).toBe('GDPR-Art35-dpia-high-risk:agent_intake');
        expect(focusRowKey(malformed<Parameters<typeof focusRowKey>[0]>(list), 'GDPR-Art35-dpia-high-risk')).toBe('GDPR-Art35-dpia-high-risk:agent_claims');
        expect(focusRowKey(malformed<Parameters<typeof focusRowKey>[0]>(list), 'GDPR-Art32-enc')).toBe('GDPR-Art32-enc:');
        expect(focusRowKey(malformed<Parameters<typeof focusRowKey>[0]>(list), 'nope')).toBeNull();
        expect(focusRowKey(null, 'GDPR-Art32-enc')).toBeNull();
        expect(focusRowKey(malformed<Parameters<typeof focusRowKey>[0]>(list), null)).toBeNull();
    });

    it('subjectLabel: the runner\'s subject_label, then agent_name, then automation_name, then the one project', () => {
        expect(subjectLabel(malformed<Parameters<typeof subjectLabel>[0]>(dpia('a', stub<Parameters<typeof dpia>[1]>('fail'), { subject_label: 'From runner', agent_name: 'From check', automation_name: 'Auto' })))).toBe('From runner');
        expect(subjectLabel(malformed<Parameters<typeof subjectLabel>[0]>(dpia('a', stub<Parameters<typeof dpia>[1]>('fail'), { subject_label: '  ', agent_name: 'Schadebeoordeling' })))).toBe('Schadebeoordeling');
        expect(subjectLabel(malformed<Parameters<typeof subjectLabel>[0]>(dpia('a', stub<Parameters<typeof dpia>[1]>('fail'), { automation_name: 'Polisbrief' })))).toBe('Polisbrief');
        expect(subjectLabel(partial<Parameters<typeof subjectLabel>[0]>({ check_id: 'x', scope_id: 'project:p1', evidence: { project_id: 'p1' }, project_names: { p1: 'Launch plan' } }))).toBe('Launch plan');
        expect(subjectLabel(partial<Parameters<typeof subjectLabel>[0]>({ check_id: 'x', scope_id: null, evidence: { offenders: [{ project_id: 'p1' }, { project_id: 'p2' }] } }))).toBeNull();
        expect(subjectLabel(partial<Parameters<typeof subjectLabel>[0]>({ check_id: 'x', evidence: null }))).toBeNull();
    });

    it('the search also finds a row by its subject\'s name', () => {
        const row = dpia('agent_claims', stub<Parameters<typeof dpia>[1]>('fail'), { agent_name: 'Schadebeoordeling' });
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(row), 'schadebeoord')).toBe(true);
        expect(matchesSearch(stub<Parameters<typeof matchesSearch>[0]>(row), 'polisintake')).toBe(false);
    });
});
