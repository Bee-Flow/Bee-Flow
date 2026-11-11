// Shared set-up of the AI Monitor tests: the demo backend with a log of what was asked,
// the licence capabilities of the viewer, and the dashboard's organisation choice.

import type { ContextType } from 'react';
import type React from 'react';
import LicenseContext from '@/components/licensing/LicenseContext';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import MonitoringPanel from '@/components/admin/monitoring';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';

type License = ContextType<typeof LicenseContext>;
type MonitoringUser = NonNullable<Parameters<typeof MonitoringPanel>[0]['user']>;

export const ADVANCED = 'advanced_usage_monitoring';
export const ORG_ADMIN: MonitoringUser = { isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-a', isHomeOrgAdmin: true };
export const PLATFORM_ADMIN: MonitoringUser = { isAdmin: true, role: 'admin' };

/** Serves the demo monitoring fixtures and returns the URLs asked for, in order. */
export function serveMonitoring(): URL[] {
    const asked: URL[] = [];
    const transport = createDemoTransport(ROUTES as unknown as DemoRoutes, createState());
    setDemoTransport(async (url: unknown, options?: RequestInit) => {
        asked.push(new URL(String(url), 'http://x'));
        return transport(url, options);
    });
    return asked;
}

/** The dashboard's choice as a platform admin (orgId: one organisation, null: all) or an organisation admin (not a platform admin). */
export function orgChoice(over: Partial<AdminOrgChoice>): AdminOrgChoice {
    return {
        isPlatformAdmin: false, orgId: null, orgName: null, organizations: [], organizationsLoaded: true, pending: false,
        homeOrganization: null, setOrgId: () => {}, ...over,
    };
}

interface RenderOptions {
    page: string;
    user: MonitoringUser;
    /** Licence capabilities the viewer holds. */
    features?: string[];
    /** The dashboard's choice; none: the panel stands alone. */
    choice?: AdminOrgChoice;
}

/** The element inside a licence that holds the advanced-monitoring capability (every page open). */
export function withAdvanced(ui: React.ReactElement): React.ReactElement {
    const license = { hasFeature: (name: string) => name === ADVANCED, deploymentMode: 'self-hosted' } as unknown as License;
    return <LicenseContext.Provider value={license}>{ui}</LicenseContext.Provider>;
}

export function renderMonitoring({ page, user, features = [], choice }: RenderOptions) {
    const license = { hasFeature: (name: string) => features.includes(name), deploymentMode: 'self-hosted' } as unknown as License;
    const panel = (
        <LicenseContext.Provider value={license}>
            <MonitoringPanel activeSection={page} user={user} />
        </LicenseContext.Provider>
    );
    return renderWithClient(choice ? <AdminOrgProvider value={choice}>{panel}</AdminOrgProvider> : panel);
}

/** Reads of one path prefix, e.g. every `/api/usage/adoption/` read. */
export const reads = (asked: URL[], prefix: string) => asked.filter((u) => u.pathname.startsWith(prefix));
