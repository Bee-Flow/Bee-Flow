import { describe, it, expect } from 'vitest';
import { compliancePath, checkPath, complianceActionPath, sectionOfPath } from './actions';

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
    });
});
