// The shape of a tab's sections that are rows of the admin dashboard's rail
// (AdminTab.railRows in adminTabs): types only, read by the registry and by the
// rail (adminRailRows).

import type { LucideIcon } from 'lucide-react';
import type { OrgSectionFacts } from '@/components/admin/organisation/orgSections';
import type { AdminTabGroupId } from './adminTabs';

/** The two top-level blocks of the rail: the organisation, and the whole server (platform admin only). */
export type AdminRailBlock = 'org' | 'instance';

/** What a rail row's gate reads. */
export interface AdminRailGateContext {
    isPlatformAdmin: boolean;
    /** An organisation admin of their home organisation, as the server tests it (utils/adminAccess). */
    isHomeOrgAdmin: boolean;
    /** The chosen organisation's section facts (organisation/orgSections), when the viewer has the Organisation tab. */
    orgFacts: OrgSectionFacts | null;
    /** The Agents hub's sections this viewer gets (agents/agentSections). */
    agentSections: readonly string[];
    /** A licence feature of the install (LicenseContext.hasFeature). */
    hasFeature: (feature: string) => boolean;
    /** The install's REAL tier reaches this one (LicenseContext.hasTier). */
    hasTier: (tier: string) => boolean;
    /**
     * Some organisation on this server is bound to a Nextcloud or came in
     * through the Nextcloud connector (useServerNextcloudFacts); undefined while
     * that is not known, which a platform admin's row reads as yes (fail open).
     */
    hasNextcloudInstances?: boolean;
}

/**
 * A section of a tab that is a row of the rail itself (admin/<tab>/<section>).
 *   row    a top-level row, in `group` of `block`: the tab gives way to its
 *          rows when every row it declares is one (the Organisation tab);
 *   child  indented under the tab's own row while that tab is open.
 */
export interface AdminRailRowDef {
    section: string;
    labelKey: string;
    labelFallback?: string;
    /** The line under the page header (AdminPage), when the row has one. */
    descriptionKey?: string;
    descriptionFallback?: string;
    icon: LucideIcon;
    group: AdminTabGroupId;
    block: AdminRailBlock;
    kind: 'row' | 'child';
    /** Shown only when this answers true; no gate, every viewer of the tab gets the row. */
    gate?: (ctx: AdminRailGateContext) => boolean;
    /** The row's section is about the whole server although it sits in the organisation block (the server mark). */
    serverWide?: boolean;
    /** The row leaves the dashboard chrome (a full-screen tool). */
    escapesChrome?: boolean;
}
