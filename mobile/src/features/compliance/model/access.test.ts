/**
 * The Compliance Center's gate: the permission hides, the capability locks,
 * a loading resolver waits and an unavailable one fails open (the web's
 * RequireTier with a feature).
 */

import { buildAccessSnapshot, type AccessSnapshot, type CompiledEntitlements, type Source } from '@/core/access';
import { compileEntitlements } from '@/core/access/model/entitlements';
import type { Entitlements, LicenseInfo } from '@/core/access/model/types';
import type { PermissionsResponse, User } from '@/core/auth/types';

import { complianceAccess, lockedHint } from './access';

const t = (_key: string, fallback: string) => fallback;

const DPO: User = { id: 'u1', displayName: 'Dee', isAdmin: false, role: 'user', provider: 'local', orgRole: 'member' };

const perms = (permissions: string[]): PermissionsResponse => ({ permissions, groups: [], organizations: [], allowedAgentTypes: [] });

function ents(effective: string[], tier = 'enterprise'): Source<CompiledEntitlements> {
    const data: Entitlements = {
        mode: 'cloud',
        tier,
        superAdmin: false,
        degraded: false,
        ceiling: { core: ['compliance_hub_gdpr'], beta: [], integration: [] },
        effective: { core: effective, beta: [], integration: [] },
        reasons: {},
        registry: [],
    };
    return { state: 'ready', data: compileEntitlements(data) };
}

const LICENCE: Source<LicenseInfo> = { state: 'ready', data: { tier: 'enterprise', source: 'license_key', features: [], serverOverride: false } };

function snap(permissions: string[], entitlements: Source<CompiledEntitlements>): AccessSnapshot {
    return buildAccessSnapshot({ user: DPO, permissions: perms(permissions), entitlements, license: LICENCE });
}

describe('complianceAccess', () => {
    it('opens for admin_compliance with the capability', () => {
        expect(complianceAccess(snap(['admin_compliance'], ents(['compliance_hub_gdpr'])))).toEqual({ state: 'open' });
    });

    it('turns away a member without the permission, whatever the plan', () => {
        expect(complianceAccess(snap(['use_apps'], ents(['compliance_hub_gdpr'])))).toEqual({ state: 'denied' });
    });

    it('locks an organisation whose plan lacks the capability', () => {
        const s = snap(['admin_compliance'], ents([], 'business'));
        const access = complianceAccess(s);
        expect(access.state).toBe('locked');
        expect(lockedHint(access, s, t)).toBeTruthy();
    });

    it('waits while the entitlements load, and fails open when they are unavailable', () => {
        expect(complianceAccess(snap(['admin_compliance'], { state: 'loading', data: null }))).toEqual({ state: 'pending' });
        expect(complianceAccess(snap(['admin_compliance'], { state: 'unavailable', data: null }))).toEqual({ state: 'open' });
    });

    it('has no hint for an open hub', () => {
        const s = snap(['admin_compliance'], ents(['compliance_hub_gdpr']));
        expect(lockedHint({ state: 'open' }, s, t)).toBe('');
        expect(lockedHint({ state: 'locked', reason: null }, s, t)).toMatch(/ask an admin/);
    });
});
