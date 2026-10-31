// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ORG_ROLES } from '../../config/orgRoles';
import { roleLabel } from './roleLabel';

/** A t() that answers its fallback, the way it does while a key is missing. */
const t = (_key: string, fallback?: string) => fallback ?? _key;

describe('roleLabel', () => {
    it('draws no chip without a role', () => {
        expect(roleLabel(null, t)).toBeNull();
        expect(roleLabel(undefined, t)).toBeNull();
        expect(roleLabel('', t)).toBeNull();
    });

    it('names the deployment super-admin through the dictionary', () => {
        const seen: string[] = [];
        const spy = (key: string, fallback?: string) => { seen.push(key); return `<${fallback}>`; };
        expect(roleLabel('admin', spy)).toBe('<Admin>');
        expect(seen).toEqual(['settings.role_admin']);
    });

    it('uses the ORG_ROLES name for every org role, including the two the old tables lacked', () => {
        expect(roleLabel('dpo', t)).toBe('Data Protection Officer');
        expect(roleLabel('isms_auditor', t)).toBe(ORG_ROLES.find((r) => r.id === 'isms_auditor')?.name);
        expect(roleLabel('isms_auditor', t)).toBe('ISMS Internal Auditor');
        for (const role of ORG_ROLES) expect(roleLabel(role.id, t)).toBe(role.name);
    });

    it('prettifies an id it does not know', () => {
        expect(roleLabel('team_lead', t)).toBe('Team Lead');
        expect(roleLabel('user', t)).toBe('User');
    });
});
