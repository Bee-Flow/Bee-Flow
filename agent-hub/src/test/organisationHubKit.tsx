// Test kit for the admin dashboard's Organisation tab
// (components/admin/organisation): the viewers, the organisations, a fetch
// stub that records every address the screen asks, the providers the tab reads
// (licence, entitlements, query cache) and the section-rule facts.

import { render } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import AdminDashboard from '@/pages/AdminDashboard';
import { withShell } from '@/test/shellProviders';
import EntitlementsContext, { type EntitlementsValue } from '@/components/licensing/EntitlementsContext';
import LicenseContext from '@/components/licensing/LicenseContext';
import type { OrgSectionFacts } from '@/components/admin/organisation/orgSections';
import type { FamilyAvailability, IntegrationFamily, OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { withQueryClient } from './queryWrapper';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

/** Listed in this order on purpose: a page that fell back to the first one would show Org A. */
export const ORGS = [{ id: 'org-a', name: 'Org A', authMethod: null }, { id: 'org-b', name: 'Org B', authMethod: null }];

/** The platform admin, whose home organisation is Org A. */
export const PLATFORM_ADMIN = {
    id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'], organizationId: 'org-a',
    homeOrganization: { id: 'org-a', name: 'Org A' },
};

/** An organisation admin of Org A by their organisation role alone: no org_admin permission. */
export const ORG_ADMIN_BY_ROLE = {
    id: 'u2', isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-a', isHomeOrgAdmin: true,
    homeOrganization: { id: 'org-a', name: 'Org A' }, permissions: [],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const FAMILIES: readonly IntegrationFamily[] = [
    'google', 'microsoft', 'nextcloud', 'github', 'n8n', 'maps', 'mcp', 'meetingNotes', 'projects', 'learningCenter', 'automations', 'imageGen',
];

interface AvailabilityOptions {
    orgId?: string;
    homeOrg?: boolean;
    /** The families that are NOT available (every other one is). */
    off?: readonly IntegrationFamily[];
    ncBound?: boolean;
    githubSync?: boolean;
}

/** The integration availability answer of one organisation: every family available unless listed in `off`. */
export function availabilityAnswer({ orgId = 'org-a', homeOrg = true, off = [], ncBound = false, githubSync = false }: AvailabilityOptions = {}): OrgIntegrationAvailability {
    const family = (id: IntegrationFamily): FamilyAvailability => (off.includes(id)
        ? { serverConfigured: true, inCeiling: false, available: false, reason: 'not_in_plan' }
        : { serverConfigured: true, inCeiling: true, available: true });
    return {
        orgId, homeOrg, degraded: false,
        families: Object.fromEntries(FAMILIES.map(id => [id, family(id)])) as Record<IntegrationFamily, FamilyAvailability>,
        nextcloud: { bound: ncBound, apps: [], pairingAvailable: !ncBound },
        microsoft: { directoryConnected: false },
        github: { syncConfigured: githubSync },
        signIn: { password: true, google: false, microsoft: false, ssoLicensed: false },
        integrations: {},
    };
}

/** The organisation an availability address asks about (/auth/organizations/<id>/integration-availability), or null. */
export function availabilityOrgOf(address: string): string | null {
    const marker = '/integration-availability';
    const end = address.indexOf(marker);
    if (end < 0) return null;
    const head = address.slice(0, end);
    return decodeURIComponent(head.slice(head.lastIndexOf('/') + 1));
}

/**
 * Answers the reads the tab makes and records every address asked; `github` is
 * the viewer's GitHub connection, `availability` the chosen organisation's
 * integration availability (every family available unless it says otherwise).
 */
export function stubOrgApi({ github = false, availability = {} }: { github?: boolean; availability?: AvailabilityOptions } = {}): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        asked.push(address);
        const availabilityOrg = availabilityOrgOf(address);
        if (availabilityOrg) return json(availabilityAnswer({ homeOrg: availabilityOrg === 'org-a', ...availability, orgId: availabilityOrg }));
        if (address.includes('/auth/organizations')) return json(ORGS);
        if (address.includes('/api/org/mcp-access')) {
            return json({ policy: { enabled: true, ipAllowlist: [], allowedUsers: { mode: 'all', roles: [], userIds: [] }, rejectLegacyTokens: false }, callerIp: null });
        }
        if (address.includes('/api/integrations/github/status')) return json({ connected: github });
        if (address.includes('/auth/groups')) return json([]);
        return json({});
    }));
    return asked;
}

/** A resolved plan snapshot with these capabilities and this ceiling. */
export function entitlements(caps: string[] = [], ceiling: string[] = []): EntitlementsValue {
    const empty = { core: [], beta: [], integration: [] };
    return {
        loading: false, degraded: false, tier: 'enterprise', mode: 'cloud', effective: empty, ceiling: empty,
        can: id => caps.includes(id), inCeiling: id => ceiling.includes(id), lockReason: () => null, hasTier: () => true, reload: () => {},
    };
}

interface RenderOrgTabOptions {
    user?: object;
    section?: string;
    /** The query string of the address, e.g. '?org=org-b' (the dashboard's choice). */
    search?: string;
    deploymentMode?: 'cloud' | 'self-hosted';
    plan?: EntitlementsValue;
}

/** The dashboard on admin/organisation/<section>. */
export function renderOrgTab({ user = PLATFORM_ADMIN, section = 'info', search = '', deploymentMode = 'cloud', plan = entitlements() }: RenderOrgTabOptions = {}) {
    window.localStorage.clear();
    window.history.replaceState(null, '', `/app/admin/organisation/${section}${search}`);
    const onNavigate = vi.fn();
    const partial: Partial<LicenseValue> = { tier: 'enterprise', deploymentMode, serverOverride: false, hasTier: () => true, hasFeature: () => true };
    const license = partial as LicenseValue;
    const withMode = { ...user, featureFlags: { deploymentMode } };
    render(withQueryClient(
        <LicenseContext.Provider value={license}>
            <EntitlementsContext.Provider value={plan}>
                {withShell(<AdminDashboard user={withMode as never} onBack={vi.fn()} onNavigate={onNavigate} adminPath={{ seg1: 'organisation', seg2: section }} />, { user: withMode, onNavigate })}
            </EntitlementsContext.Provider>
        </LicenseContext.Provider>,
    ));
    return { onNavigate };
}

/**
 * The section-rule facts of an organisation admin on cloud whose organisation
 * has every family but GitHub and is not bound to a Nextcloud; override what a
 * case is about.
 */
export function orgFacts(over: Partial<OrgSectionFacts> = {}): OrgSectionFacts {
    return {
        canSeeOrg: true, canManageKnowledge: false, isSelfHosted: false, isNcConnectorUser: false, isPlatformAdmin: false,
        ncBound: false, ncSectionAvailable: false, githubAvailable: false, microsoft365: false,
        meetingNotes: true, mcp: true, projects: true, learningCenter: true, automations: true,
        ...over,
    };
}
