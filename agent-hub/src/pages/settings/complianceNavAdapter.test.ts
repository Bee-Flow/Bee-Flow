// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { rewriteComplianceNav } from './complianceNavAdapter';

describe('rewriteComplianceNav', () => {
    it('maps the bare hub path to overview', () => {
        expect(rewriteComplianceNav('admin/compliance')).toEqual({
            section: 'overview',
            checkId: '',
            tab: '',
            url: '/app/settings/organisation/compliance/overview',
        });
    });

    it('maps a section path', () => {
        expect(rewriteComplianceNav('admin/compliance/gdpr')).toEqual({
            section: 'gdpr',
            checkId: '',
            tab: '',
            url: '/app/settings/organisation/compliance/gdpr',
        });
    });

    it('keeps compliance settings inside the settings surface', () => {
        // The remediation link of DPO/notice/breach checks — must NOT bounce
        // the user out to the admin dashboard.
        expect(rewriteComplianceNav('admin/compliance/settings')!.url)
            .toBe('/app/settings/organisation/compliance/settings');
    });

    it('decodes the check id but keeps the URL segment encoded', () => {
        const hit = rewriteComplianceNav('admin/compliance/gdpr/GDPR-Art32%20x');
        expect(hit!.section).toBe('gdpr');
        expect(hit!.checkId).toBe('GDPR-Art32 x');
        expect(hit!.url).toBe('/app/settings/organisation/compliance/gdpr/GDPR-Art32%20x');
    });

    it('keeps the query on the url and returns the tab; the section never contains "?"', () => {
        // The hub re-reads ?tab= whenever the pathname changes — a URL pushed
        // without it lands on the first tab (the Overview › Calendar bug).
        expect(rewriteComplianceNav('admin/compliance/frameworks?tab=calendar')).toEqual({
            section: 'frameworks',
            checkId: '',
            tab: 'calendar',
            url: '/app/settings/organisation/compliance/frameworks?tab=calendar',
        });
        const deep = rewriteComplianceNav('admin/compliance/soa/A.5.1?tab=history');
        expect(deep).toMatchObject({ section: 'soa', checkId: 'A.5.1', tab: 'history' });
        expect(deep!.url).toBe('/app/settings/organisation/compliance/soa/A.5.1?tab=history');
        expect(rewriteComplianceNav('admin/compliance?tab=reports')).toMatchObject({ section: 'overview', tab: 'reports' });
        for (const p of ['admin/compliance/frameworks?tab=calendar', 'admin/compliance?tab=x', 'admin/compliance/dsr/r1?tab=y']) {
            expect(rewriteComplianceNav(p)!.section).not.toContain('?');
            expect(rewriteComplianceNav(p)!.checkId).not.toContain('?');
        }
    });

    it('passes through non-compliance admin paths', () => {
        // e.g. the Art-32 access-logging remediation link → admin dashboard.
        expect(rewriteComplianceNav('admin/monitoring/activity')).toBeNull();
        expect(rewriteComplianceNav('admin/security')).toBeNull();
    });

    it('does not match prefixes of other tabs', () => {
        expect(rewriteComplianceNav('admin/compliance-other')).toBeNull();
    });

    it('handles empty and missing input', () => {
        expect(rewriteComplianceNav('')).toBeNull();
        expect(rewriteComplianceNav(undefined)).toBeNull();
    });
});
