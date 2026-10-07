/** The hub's pure navigation: sections, their tabs, and where a server target opens. */

import { attentionTarget, parseTarget, recordRoute, REPORTS, sectionRoute, targetRoute } from './navigation';
import { frameworkIdOf, HUB_PAGES, LEGACY_TABS, pageRoute, resolveTab, SECTIONS, sectionById, sectionForRegulation, sectionsInGroup, tabLabel, tabsOfSection, visibleSections } from './sections';

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

describe('section tabs', () => {
    const ids = (id: string) => tabsOfSection(sectionById(id)!).map((t) => t.id);

    it('gives frameworks their tabs, registers one per type, pages none', () => {
        expect(ids('gdpr')).toEqual(['checks', 'timeline', 'evidence']);
        expect(ids('aia')).toEqual(['checks', 'timeline', 'evidence', 'systems']);
        expect(tabsOfSection(sectionById('dsr')!)).toEqual([{ id: 'requests', type: 'dsr' }, { id: 'public_form' }]);
        expect(tabsOfSection(sectionById('training')!)).toEqual([{ id: 'personnel', type: 'personnel' }, { id: 'obligations', type: 'obligations' }]);
        expect(ids('incidents')).toEqual(['incidents']);
        expect(ids('overview')).toEqual([]);
        expect(ids('ropa')).toEqual([]);
    });

    it('labels a tab by the web key, or by its record type', () => {
        expect(tabLabel('aia', 'systems').i18nKey).toBe('compliance.tab_aia_systems');
        expect(tabLabel('audits', 'ncs').i18nKey).toBe('compliance.tab_audits_ncs');
        expect(tabLabel('training', 'obligations').i18nKey).not.toMatch(/^compliance\.tab_/);
    });

    it('resolves a moved tab', () => {
        expect(resolveTab('kaders', 'per_automation')).toEqual({ section: 'aia', tab: 'systems', page: null });
        expect(resolveTab('frameworks', 'calendar')).toEqual({ section: 'frameworks', tab: null, page: 'calendar' });
        expect(resolveTab('dsr', 'settings')).toEqual({ section: 'settings', tab: null, page: null });
        expect(resolveTab('dsr', 'requests')).toEqual({ section: 'dsr', tab: 'requests', page: null });
        expect(resolveTab('dsr', 'constructor')).toEqual({ section: 'dsr', tab: 'constructor', page: null });
    });

    it('keeps the hub pages apart from every section and alias', () => {
        for (const page of HUB_PAGES) expect(sectionById(page)).toBeNull();
        expect(pageRoute('calendar')).toBe('/org/compliance/calendar');
        expect(Object.keys(LEGACY_TABS).every((id) => SECTIONS.some((s) => s.id === id))).toBe(true);
    });
});

describe('navigation', () => {
    it('maps the server target onto the phone routes', () => {
        const item = { source: 'register', code: 'x', id: 'register:x', meta: { frameworks: [] }, action: { target: '/app/admin/compliance/incidents/12' } };
        expect(attentionTarget(item)).toMatchObject({ section: 'incidents', id: '12' });
        expect(targetRoute(attentionTarget(item))).toBe('/org/compliance/incidents/12');
        const check = { source: 'check', code: 'GDPR-Art30', id: 'check:x', meta: { frameworks: [{ regulation: 'GDPR' }] }, action: { target: 'https://elsewhere' } };
        expect(attentionTarget(check)).toEqual({ section: 'gdpr', id: 'GDPR-Art30' });
        expect(targetRoute({ section: 'iso_audit', id: '3' })).toBe('/org/compliance/audits/3');
        expect(targetRoute({ section: 'dsr', id: null })).toBe('/org/compliance/dsr');
        expect(targetRoute({ section: 'overview', id: null })).toBe('/org/compliance');
        expect(sectionRoute('soa')).toBe('/org/compliance/soa');
        expect(recordRoute('soa', 'A.5.1')).toBe('/org/compliance/soa/A.5.1');
    });

    it.each([
        ['/app/admin/compliance/dsr/12', { section: 'dsr', id: '12', tab: null, page: null }, '/org/compliance/dsr/12'],
        ['admin/compliance/dsr?id=r%201', { section: 'dsr', id: 'r 1' }, '/org/compliance/dsr/r%201'],
        ['/app/admin/compliance/soa?tab=history', { section: 'soa', id: null, tab: 'history' }, '/org/compliance/soa?tab=history'],
        ['/app/admin/compliance/soa/A.5?tab=history', { section: 'soa', id: 'A.5', tab: 'history' }, '/org/compliance/soa/A.5'],
        ['/app/admin/compliance/frameworks?tab=per_automation', { section: 'aia', id: null, tab: 'systems' }, '/org/compliance/aia?tab=systems'],
        ['/app/admin/compliance/audits/a1?tab=obligations', { section: 'training', id: null, tab: 'obligations' }, '/org/compliance/training?tab=obligations'],
        ['/app/admin/compliance/frameworks?tab=calendar', { section: 'overview', page: 'calendar' }, '/org/compliance/calendar'],
        ['/app/admin/compliance/overview?tab=calendar', { section: 'overview', page: 'calendar' }, '/org/compliance/calendar'],
        ['/app/admin/compliance/setup', { section: 'overview', page: 'setup' }, '/org/compliance/setup'],
        ['/app/admin/compliance/iso_soa', { section: 'soa', id: null }, '/org/compliance/soa'],
        ['/app/admin/compliance', { section: 'overview', id: null }, '/org/compliance'],
    ])('parses %s', (path, target, route) => {
        const parsed = parseTarget(path);
        expect(parsed).toMatchObject(target);
        expect(targetRoute(parsed!)).toBe(route);
    });

    it('parses the object shape and refuses what is not the hub', () => {
        expect(parseTarget({ section: 'iso_risks', id: 4 })).toMatchObject({ section: 'risks', id: '4' });
        expect(parseTarget({ page: 'calendar' })).toMatchObject({ page: 'calendar' });
        for (const junk of [null, 3, '/app/admin/settings', '/app/admin/compliance/nope', { section: 7 }]) expect(parseTarget(junk)).toBeNull();
    });

    it('groups the reports, core first', () => {
        expect(REPORTS.map((r) => r.group)).toEqual(['core', 'core', 'iso', 'iso', 'iso', 'iso', 'iso']);
    });
});
