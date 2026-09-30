/**
 * evaluateGate: person gates hide, entitlement gates hide or lock, and a lock
 * is only ever shown on the strength of a real answer.
 */

import type { PermissionsResponse, User } from '@/core/auth/types';

import { compileEntitlements } from './entitlements';
import { evaluateGate, type Gate } from './gate';
import { lockHint } from './lockHint';
import { buildAccessSnapshot, type Source } from './snapshot';
import type { AccessSnapshot, CompiledEntitlements, Entitlements, LicenseInfo } from './types';

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole: 'member' };

const perms = (permissions: string[], extra: Partial<PermissionsResponse> = {}): PermissionsResponse => ({
    permissions,
    groups: [],
    organizations: [],
    allowedAgentTypes: [],
    ...extra,
});

const DATA: Entitlements = {
    mode: 'cloud',
    tier: 'enterprise',
    superAdmin: false,
    degraded: false,
    ceiling: { core: ['automations', 'app_studio'], beta: ['webpages'], integration: [] },
    effective: { core: ['automations'], beta: [], integration: [] },
    reasons: {},
    registry: [{ id: 'app_studio', kind: 'core', licenseFeature: 'apps' }],
};

const READY: Source<CompiledEntitlements> = { state: 'ready', data: compileEntitlements(DATA) };
const LICENCE: Source<LicenseInfo> = {
    state: 'ready',
    data: { tier: 'enterprise', source: 'license_key', features: ['automations'], serverOverride: false },
};

function snapshot(over: {
    user?: Partial<User>;
    permissions?: string[];
    extra?: Partial<PermissionsResponse>;
    entitlements?: Source<CompiledEntitlements>;
} = {}): AccessSnapshot {
    return buildAccessSnapshot({
        user: { ...ADA, ...over.user },
        permissions: perms(over.permissions ?? ['use_apps', 'manage_agents'], over.extra),
        entitlements: over.entitlements ?? READY,
        license: LICENCE,
    });
}

const open = { visible: true, locked: false, reason: null };

describe('evaluateGate: person gates hide', () => {
    it('an empty gate is open', () => {
        expect(evaluateGate({}, snapshot())).toEqual(open);
    });

    it.each<[string, Gate, ReturnType<typeof snapshot>, string]>([
        ['super admin', { superAdmin: true }, snapshot({ permissions: ['all'] }), 'super_admin'],
        ['org admin', { orgAdmin: true }, snapshot({ permissions: ['manage_users'] }), 'org_admin'],
        ['simple mode', { notSimpleMode: true }, snapshot({ user: { simpleMode: true } }), 'simple_mode'],
        ['a flag', { flag: 'notebooks' }, snapshot({ user: { featureFlags: { notebooks: false } } }), 'flag_off'],
        ['every permission', { perms: ['use_apps', 'use_forms'] }, snapshot(), 'permission'],
        ['any permission', { anyPerms: ['use_forms', 'manage_apps'] }, snapshot(), 'permission'],
    ])('%s', (_name, gate, snap, reason) => {
        expect(evaluateGate({ ...gate, lockOn: 'disable' }, snap)).toEqual({ visible: false, locked: false, reason });
    });

    it('passes the person gates that hold', () => {
        expect(evaluateGate({ perms: ['use_apps'], anyPerms: ['nope', 'manage_agents'] }, snapshot())).toEqual(open);
        expect(evaluateGate({ orgAdmin: true }, snapshot({ user: { orgRole: 'org_admin' } }))).toEqual(open);
        expect(evaluateGate({ anyPerms: [] }, snapshot({ permissions: [] }))).toEqual(open);
    });

    it('a person gate wins over an entitlement lock: no upgrade signpost for someone kept out anyway', () => {
        const gate: Gate = { can: 'app_studio', perms: ['manage_apps'], lockOn: 'disable' };
        expect(evaluateGate(gate, snapshot())).toMatchObject({ visible: false, reason: 'permission' });
    });
});

describe('evaluateGate: entitlement gates', () => {
    it('open when granted, through either namespace', () => {
        expect(evaluateGate({ can: 'automations', license: 'automations' }, snapshot())).toEqual(open);
    });

    it('hide by default, with the lock reason', () => {
        expect(evaluateGate({ license: 'apps' }, snapshot())).toEqual({ visible: false, locked: false, reason: 'not_granted' });
    });

    it("lock with lockOn 'disable': ask-an-admin inside the plan, upgrade outside it", () => {
        expect(evaluateGate({ can: 'apps', lockOn: 'disable' }, snapshot())).toEqual({
            visible: true,
            locked: true,
            reason: 'not_granted',
        });
        expect(evaluateGate({ can: 'datatables', lockOn: 'disable' }, snapshot())).toEqual({
            visible: true,
            locked: true,
            reason: 'ceiling',
        });
    });

    it('never lock before the answer is real', () => {
        const loading = snapshot({ entitlements: { state: 'loading', data: null } });
        expect(evaluateGate({ can: 'apps', lockOn: 'disable' }, loading)).toEqual({
            visible: false,
            locked: false,
            reason: 'pending',
        });
        const failed = snapshot({ entitlements: { state: 'unavailable', data: null } });
        expect(evaluateGate({ can: 'apps', lockOn: 'disable' }, failed)).toMatchObject({ visible: false, reason: 'unavailable' });
        // The licence list still answers a licence gate during an outage.
        expect(evaluateGate({ license: 'automations' }, failed)).toEqual(open);
    });

    it('canUse follows the server map; a no the entitlements do not explain hides', () => {
        const snap = snapshot({ extra: { canUseFeature: { webpages: false, automations: false } } });
        expect(evaluateGate({ canUse: 'webpages', lockOn: 'disable' }, snap)).toEqual({
            visible: true,
            locked: true,
            reason: 'not_granted',
        });
        expect(evaluateGate({ canUse: 'automations', lockOn: 'disable' }, snap)).toMatchObject({
            visible: false,
            reason: 'not_entitled',
        });
    });
});

describe('lockHint', () => {
    const t = (_key: string, fallback: string) => fallback;

    it('says ask-an-admin, finish-the-course or upgrade', () => {
        expect(lockHint('not_granted', t)).toMatch(/ask an admin/);
        expect(lockHint('training', t)).toBe('Finish the required course first');
        expect(lockHint('ceiling', t)).toBe('Available on a higher plan');
        expect(lockHint('something_new', t)).toBe('Available on a higher plan');
    });
});
