/**
 * The snapshot and its questions: what it takes from which answer, and that
 * loading and failure are never read as a refusal worth a lock.
 */

import type { PermissionsResponse, User } from '@/core/auth/types';

import { compileEntitlements } from './entitlements';
import {
    buildAccessSnapshot,
    can,
    canUse,
    featureEnabled,
    hasLicenseFeature,
    hasTier,
    holds,
    holdsAny,
    inCeiling,
    lockReason,
    type Source,
} from './snapshot';
import type { CompiledEntitlements, Entitlements, LicenseInfo } from './types';

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', organizationId: 'o1' };

const perms = (permissions: string[], extra: Partial<PermissionsResponse> = {}): PermissionsResponse => ({
    permissions,
    groups: [],
    organizations: [],
    allowedAgentTypes: [],
    ...extra,
});

const DATA: Entitlements = {
    mode: 'self-hosted',
    tier: 'enterprise',
    superAdmin: false,
    degraded: false,
    ceiling: { core: ['automations', 'app_studio'], beta: [], integration: [] },
    effective: { core: ['automations'], beta: [], integration: [] },
    reasons: { app_studio: 'not_granted', webpages: 'ceiling' },
    registry: [{ id: 'app_studio', kind: 'core', licenseFeature: 'apps' }],
};

const READY: Source<CompiledEntitlements> = { state: 'ready', data: compileEntitlements(DATA) };
const LICENCE: Source<LicenseInfo> = {
    state: 'ready',
    data: { tier: 'full', source: 'license_key', features: ['webpages', 'apps'], serverOverride: true },
};

describe('buildAccessSnapshot', () => {
    it('is a signed-out nobody with no inputs', () => {
        const snap = buildAccessSnapshot({ user: null, permissions: null });
        expect(snap).toMatchObject({
            hasUser: false,
            isSuperAdmin: false,
            isOrgAdmin: false,
            permissionsLoaded: false,
            entitlementsState: 'loading',
            licenseState: 'loading',
            mode: 'cloud',
            tier: 'community',
        });
    });

    it('takes the orgRole from my-permissions when the login user has none', () => {
        const snap = buildAccessSnapshot({ user: ADA, permissions: perms(['use_apps'], { orgRole: 'org_admin' }) });
        expect(snap.orgRole).toBe('org_admin');
        expect(snap.isOrgAdmin).toBe(true);
    });

    it('carries Simple Mode, the flags, the organisation and the maps', () => {
        const snap = buildAccessSnapshot({
            user: {
                ...ADA,
                simpleMode: true,
                organization: { id: 'o1', name: 'Acme', logo: null },
                featureFlags: { notebooks: false, deploymentMode: 'self-hosted' },
            },
            permissions: perms([], { betaFeatures: ['webpages'], canUseFeature: { webpages: true } }),
        });
        expect(snap.simpleMode).toBe(true);
        expect(snap.organization?.name).toBe('Acme');
        expect(featureEnabled(snap, 'notebooks')).toBe(false);
        expect(featureEnabled(snap, 'projects')).toBe(true);
        expect(snap.mode).toBe('self-hosted');
        expect(canUse(snap, 'webpages')).toBe(true);
    });

    it('prefers the entitlement tier and mode, then the licence', () => {
        const both = buildAccessSnapshot({ user: ADA, permissions: null, entitlements: READY, license: LICENCE });
        expect(both.tier).toBe('enterprise');
        expect(both.mode).toBe('self-hosted');
        const licenceOnly = buildAccessSnapshot({ user: ADA, permissions: null, license: LICENCE });
        expect(licenceOnly.tier).toBe('full');
        expect(hasTier(licenceOnly, 'enterprise')).toBe(true);
        expect(hasTier(both, 'full')).toBe(false);
    });
});

describe('the entitlement questions', () => {
    const snap = buildAccessSnapshot({ user: ADA, permissions: perms([]), entitlements: READY, license: LICENCE });

    it('can / inCeiling / lockReason answer from a ready snapshot', () => {
        expect(can(snap, 'automations')).toBe(true);
        expect(can(snap, 'apps')).toBe(false);
        expect(inCeiling(snap, 'apps')).toBe(true);
        expect(lockReason(snap, 'apps')).toBe('not_granted');
        expect(lockReason(snap, 'webpages')).toBe('ceiling');
        expect(lockReason(snap, 'automations')).toBeNull();
    });

    it('hasLicenseFeature follows the entitlements, not the licence list, when they answered', () => {
        // The licence lists `apps`, but the org has not switched App Studio on.
        expect(hasLicenseFeature(snap, 'apps')).toBe(false);
        expect(hasLicenseFeature(snap, 'automations')).toBe(true);
    });

    it('while loading: nothing is granted and nothing is locked', () => {
        const loading = buildAccessSnapshot({ user: ADA, permissions: null, license: LICENCE });
        expect(can(loading, 'automations')).toBe(false);
        expect(lockReason(loading, 'webpages')).toBeNull();
        expect(hasLicenseFeature(loading, 'webpages')).toBe(false);
    });

    it('when the entitlements are unavailable, the licence list answers the licence question', () => {
        const failed = buildAccessSnapshot({
            user: ADA,
            permissions: null,
            entitlements: { state: 'unavailable', data: null },
            license: LICENCE,
        });
        expect(hasLicenseFeature(failed, 'webpages')).toBe(true);
        expect(hasLicenseFeature(failed, 'automations')).toBe(false);
        expect(can(failed, 'webpages')).toBe(false);
        expect(lockReason(failed, 'webpages')).toBeNull();
    });
});

describe('the permission questions', () => {
    it('honour `all`, and the super-admin session flag before my-permissions answers', () => {
        const admin = buildAccessSnapshot({ user: { ...ADA, isAdmin: true }, permissions: null });
        expect(holds(admin, 'manage_agents')).toBe(true);
        expect(admin.isSuperAdmin && admin.isOrgAdmin).toBe(true);
        const all = buildAccessSnapshot({ user: ADA, permissions: perms(['all']) });
        expect(holdsAny(all, ['manage_agents'])).toBe(true);
        const plain = buildAccessSnapshot({ user: ADA, permissions: perms(['use_apps']) });
        expect(holds(plain, 'manage_agents')).toBe(false);
        expect(holdsAny(plain, ['manage_agents', 'use_apps'])).toBe(true);
    });
});
