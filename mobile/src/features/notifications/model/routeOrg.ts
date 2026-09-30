/**
 * Where the web's organisation addresses open on the phone.
 *
 *   /app/settings/organisation/<segment>   settingsRoutes.js SETTINGS_ORG_ID_TO_URL
 *                                          (…/license?checkout=success is the
 *                                          Stripe return URL)
 *   /app/org-settings/<tab>[/<sub>]        the legacy OrgSettings.jsx page
 *   /app/admin/<tab>[/<sub>]               the admin dashboard's org-admin tabs
 *                                          (auth/connectorJwt.js links
 *                                          /app/admin/security/users; the
 *                                          compliance tab is routeCompliance.ts)
 *
 * The segment table is pinned to the web's and to features/org's section
 * registry by routeOrg.lockstep.test.ts rather than imported: an import of a
 * feature index from here would pull that feature into every notification.
 * The global admin dashboard itself is not on the phone, so an admin tab with
 * no org-side equivalent lands on the organisation index.
 */

import type { NotificationTarget } from './route';
import { complianceTarget } from './routeCompliance';

/** SETTINGS_ORG_ID_TO_URL's segments → the section's screen. */
export const ORG_SETTINGS_SEGMENTS: Readonly<Record<string, string>> = {
    license: '/org/billing',
    auth: '/org/sign-in',
    privacy: '/org/shield',
    encryption: '/org/encryption',
    info: '/org/info',
    usage: '/org/usage',
    compliance: '/org/compliance',
    users: '/org/people',
    academy: '/org/academy',
    integrations: '/org/integrations',
    'github-sync': '/org/github-sync',
    'nextcloud-sync': '/org/nextcloud',
    'meeting-templates': '/org/meeting-templates',
    azure: '/org/azure',
};

/** OrgSettings.jsx tabs, and the users tab's sub-sections. */
const LEGACY_TABS: Readonly<Record<string, string>> = {
    organisation: '/org',
    'knowledge-bases': '/org/knowledge-bases',
    'github-sync': '/org/github-sync',
    'nextcloud-sync': '/org/nextcloud',
    users: '/org/people',
};

const USERS_SUBS: Readonly<Record<string, string>> = {
    users: '/org/members',
    groups: '/org/groups',
    roles: '/org/roles',
    customTiers: '/org/model-tiers',
    sync: '/org/nextcloud',
};

/** The admin dashboard tabs an org admin reaches, and their org-side homes. */
const ADMIN_TABS: Readonly<Record<string, string>> = {
    security: '/org/members',
    access: '/org/access',
    monitoring: '/org/usage',
};

/**
 * Sub-sections with a home of their own. `/app/admin/security/users` has one
 * writer, auth/connectorJwt.js's "New user awaiting approval": the members
 * list opens on the sign-ups waiting for approval (app/org/members reads
 * `?status=pending`), not on everyone.
 */
const ADMIN_SUBS: Readonly<Record<string, string>> = {
    'security/users': '/org/members?status=pending',
};

/** `/app/settings/organisation/<segment>`; an unknown segment opens the index. */
export function orgSettingsTarget(segment: string | undefined): NotificationTarget {
    return { href: (segment && ORG_SETTINGS_SEGMENTS[segment]) || '/org' };
}

/** `/app/org-settings/<tab>[/<sub>]`. */
export function legacyOrgSettingsTarget(tab: string | undefined, sub: string | undefined): NotificationTarget {
    if (tab === 'users' && sub && USERS_SUBS[sub]) return { href: USERS_SUBS[sub] as string };
    return { href: (tab && LEGACY_TABS[tab]) || '/org' };
}

/**
 * `/app/admin/<tab>/…`: security → members, compliance → its section or
 * record, and so on; the rest → the index. `rest` is what follows the tab.
 */
export function adminTarget(tab: string | undefined, rest: readonly string[] = [], query = ''): NotificationTarget {
    if (tab === 'compliance') return complianceTarget(rest[0], rest[1], query);
    const href = (tab && rest[0] ? ADMIN_SUBS[`${tab}/${rest[0]}`] : undefined) ?? (tab ? ADMIN_TABS[tab] : undefined);
    return href ? { href } : { href: '/org', approximate: true };
}
