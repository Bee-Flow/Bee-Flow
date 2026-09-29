import { describe, it, expect } from 'vitest';
import {
    belongsToRegulation, checksForRegulation, otherFrameworkRefs, articleForRegulation, articleNumber, articleKey,
    sortChecks, filterByStatus, countByStatus, matchesSearch, resolveRemediation, canFollow, autoFixCount,
    formatRunAt, shortHash, frameworkIdOf, isOpen,
} from './checkSort';

const c = (check_id, status, severity, article, extra = {}) => ({ check_id, status, severity, article, regulation: 'GDPR', ...extra });

const LIST = [
    c('GDPR-Art32-enc', 'pass', 'critical', '32'),
    c('GDPR-Art5-min', 'warn', 'low', '5(1)(c)'),
    c('GDPR-Art33-breach', 'fail', 'high', '33', { frameworks: [{ regulation: 'GDPR', ref: '33' }, { regulation: 'ISO27001', ref: 'A.5.24' }] }),
    c('GDPR-Art13-notice', 'fail', 'critical', '13'),
    c('GDPR-Art28-dpa', 'not_applicable', 'medium', '28'),
    c('GDPR-Art30-ropa', 'warn', 'high', '30'),
];

describe('checkSort — membership', () => {
    it('a check belongs to its home regulation and to every framework it is tagged for', () => {
        const breach = LIST[2];
        expect(belongsToRegulation(breach, 'GDPR')).toBe(true);
        expect(belongsToRegulation(breach, 'ISO27001')).toBe(true);
        expect(belongsToRegulation(breach, 'AIA')).toBe(false);
        expect(checksForRegulation(LIST, 'ISO27001').map((x) => x.check_id)).toEqual(['GDPR-Art33-breach']);
        expect(checksForRegulation(null, 'GDPR')).toEqual([]);
    });

    it('otherFrameworkRefs lists the OTHER ledgers only, deduplicated, home article included when the page is not home', () => {
        const breach = LIST[2];
        expect(otherFrameworkRefs(breach, 'GDPR')).toEqual([{ regulation: 'ISO27001', ref: 'A.5.24' }]);
        expect(otherFrameworkRefs(breach, 'ISO27001')).toEqual([{ regulation: 'GDPR', ref: '33' }]);
        expect(otherFrameworkRefs(LIST[0], 'GDPR')).toEqual([]);
    });

    it('articleForRegulation shows the tagged ref on a foreign page and the home article at home', () => {
        expect(articleForRegulation(LIST[2], 'ISO27001')).toBe('A.5.24');
        expect(articleForRegulation(LIST[2], 'GDPR')).toBe('33');
        expect(articleNumber('A.8.24')).toBe(8);
        expect(articleNumber('5(1)(c)')).toBe(5);
        expect(Number.isNaN(articleNumber('—'))).toBe(true);
        expect(articleKey('A.5.24')).toEqual([5, 24]);
        // Segment-wise: A.5.9 comes before A.5.24 (a float compare would invert them).
        const iso = [c('x', 'pass', 'low', 'A.5.24'), c('y', 'pass', 'low', 'A.5.9'), c('z', 'pass', 'low', 'A.5.10')];
        expect(sortChecks(iso, 'by_article', 'GDPR').map((x) => x.article)).toEqual(['A.5.9', 'A.5.10', 'A.5.24']);
    });
});

describe('checkSort — order and filters', () => {
    it('by_status: fail → warn → pass → n/a, severity inside a band, then article', () => {
        const ids = sortChecks(LIST, 'by_status', 'GDPR').map((x) => x.check_id);
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
        const ids = sortChecks(LIST, 'by_article', 'GDPR').map((x) => x.article);
        expect(ids).toEqual(['5(1)(c)', '13', '28', '30', '32', '33']);
        expect(sortChecks(LIST, 'nonsense', 'GDPR')[0].check_id).toBe('GDPR-Art13-notice');
        expect(sortChecks(LIST, 'by_article', 'GDPR')).not.toBe(LIST); // a copy
    });

    it('pills filter by status and count every band; `all` is the whole list', () => {
        expect(countByStatus(LIST)).toEqual({ all: 6, fail: 2, warn: 2, pass: 1, not_applicable: 1 });
        expect(filterByStatus(LIST, 'warn').map((x) => x.check_id)).toEqual(['GDPR-Art5-min', 'GDPR-Art30-ropa']);
        expect(filterByStatus(LIST, 'all')).toHaveLength(6);
        expect(isOpen('fail')).toBe(true); expect(isOpen('warn')).toBe(true); expect(isOpen('pass')).toBe(false);
    });

    it('search matches the translated title, id, article, details and tagged refs, case-insensitively', () => {
        const titleOf = (x) => (x.check_id === 'GDPR-Art33-breach' ? 'Breach detection' : '');
        expect(matchesSearch(LIST[2], 'BREACH DET', titleOf)).toBe(true);
        expect(matchesSearch(LIST[2], 'a.5.24')).toBe(true);
        expect(matchesSearch(LIST[0], '32')).toBe(true);
        expect(matchesSearch(LIST[0], 'nothing here')).toBe(false);
        expect(matchesSearch(LIST[0], '   ')).toBe(true);
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
        expect(autoFixCount({ evidence: { missing_disclosure: [{ id: 'a' }, { id: 'b' }] } })).toBe(2);
        expect(autoFixCount({ auto_fix_count: 7 })).toBe(7);
        expect(autoFixCount({ evidence: { other: 1 } })).toBeNull();
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
