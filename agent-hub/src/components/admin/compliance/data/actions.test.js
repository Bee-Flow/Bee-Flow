import { describe, it, expect } from 'vitest';
import { compliancePath, checkPath, complianceActionPath, sectionOfPath, tabOfPath, resolveTarget } from './actions';

describe('compliance actions — every emitted path is admin/compliance/<canonical>[/<id>]', () => {
    it('compliancePath canonicalises aliases and encodes the id', () => {
        expect(compliancePath('gdpr')).toBe('admin/compliance/gdpr');
        expect(compliancePath('iso_soa')).toBe('admin/compliance/soa');
        expect(compliancePath('nope')).toBe('admin/compliance/overview');
        // Parentheses are legal in a path segment (encodeURIComponent keeps them); a slash is not.
        expect(compliancePath('nis2', 'NIS2-Art21(2)(j)-admin-mfa')).toBe('admin/compliance/nis2/NIS2-Art21(2)(j)-admin-mfa');
        expect(compliancePath('dsr', 'req/1')).toBe('admin/compliance/dsr/req%2F1');
    });

    it('checkPath lands in the section that scores the regulation', () => {
        expect(checkPath({ regulation: 'GDPR', check_id: 'GDPR-Art28-subprocessors' })).toBe('admin/compliance/gdpr/GDPR-Art28-subprocessors');
        expect(checkPath({ regulation: 'ISO27001', check_id: 'ISO27001-A.5.20-suppliers' })).toBe('admin/compliance/iso/ISO27001-A.5.20-suppliers');
        expect(checkPath({ regulation: 'CRA', check_id: 'CRA-Art14-vuln-reporting-clocks' })).toBe('admin/compliance/cra/CRA-Art14-vuln-reporting-clocks');
    });

    it('complianceActionPath normalises server targets and refuses what the router must never see', () => {
        expect(complianceActionPath({ type: 'navigate', target: '/app/admin/compliance/ropa' })).toBe('admin/compliance/ropa');
        expect(complianceActionPath({ type: 'open_fix', target: 'admin/security/guardrails' })).toBe('admin/security/guardrails');
        expect(complianceActionPath({ type: 'navigate', target: '/app/settings/organisation/compliance/soa/A.5.20' })).toBe('admin/compliance/soa/A.5.20');
        expect(complianceActionPath('admin/agents')).toBe('admin/agents');
        expect(complianceActionPath({ type: 'auto_fix' })).toBeNull();
        expect(complianceActionPath({ type: 'navigate', target: 'https://evil.example/x' })).toBeNull();
        expect(complianceActionPath(null)).toBeNull();
        expect(complianceActionPath({ type: 'navigate' })).toBeNull();
    });

    it('sectionOfPath reads the section back (aliases included) and null outside the hub', () => {
        expect(sectionOfPath('admin/compliance/iso_soa/A.5.1')).toBe('soa');
        expect(sectionOfPath('admin/compliance')).toBe('overview');
        expect(sectionOfPath('admin/security/users')).toBeNull();
        expect(sectionOfPath('admin/compliance-other')).toBeNull();
    });

    it('sectionOfPath never captures the query: a target with ?tab= is not a dead click', () => {
        expect(sectionOfPath('admin/compliance/frameworks?tab=per_automation')).toBe('frameworks');
        expect(sectionOfPath('admin/compliance?tab=calendar')).toBe('overview');
        expect(sectionOfPath('admin/compliance/dsr/req%2F1?tab=x')).toBe('dsr');
    });

    it('compliancePath carries a tab in the query', () => {
        expect(compliancePath('frameworks', null, 'calendar')).toBe('admin/compliance/frameworks?tab=calendar');
        expect(compliancePath('iso_soa', 'A.5.1', 'history')).toBe('admin/compliance/soa/A.5.1?tab=history');
        expect(compliancePath('gdpr', undefined, null)).toBe('admin/compliance/gdpr');
    });

    it('tabOfPath reads ?tab= and nothing else', () => {
        expect(tabOfPath('admin/compliance/frameworks?tab=per_automation')).toBe('per_automation');
        expect(tabOfPath('admin/compliance/frameworks?x=1&tab=calendar#top')).toBe('calendar');
        expect(tabOfPath('admin/compliance/frameworks')).toBeNull();
        expect(tabOfPath('admin/compliance/frameworks?tab=')).toBeNull();
        expect(tabOfPath(null)).toBeNull();
    });

    it('resolveTarget → { section, id, tab }, with the legacy tab aliases applied', () => {
        expect(resolveTarget('admin/compliance/audits?tab=obligations')).toEqual({ section: 'training' });
        expect(resolveTarget('admin/compliance/iso_audit?tab=obligations')).toEqual({ section: 'training' });
        expect(resolveTarget('admin/compliance/frameworks?tab=per_automation')).toEqual({ section: 'frameworks', tab: 'per_automation' });
        expect(resolveTarget('admin/compliance/dsr/req%2F1')).toEqual({ section: 'dsr', id: 'req/1' });
        expect(resolveTarget('admin/compliance/audits?tab=ncs')).toEqual({ section: 'audits', tab: 'ncs' });
        expect(resolveTarget('admin/compliance')).toEqual({ section: 'overview' });
        expect(resolveTarget('admin/agents')).toBeNull();
        expect(resolveTarget('')).toBeNull();
    });
});
