// The one rule for "which catalogue integrations may this agent (or skill) be
// given", used by the Agent Studio builder, the skill editor and the legacy
// Agent Designer. Two modes:
//
//   user   the person editing gets what they can use themselves: the org's
//          allow-list, then the login or the personal key each app runs on
//          (the raw GET /ai/user-settings payload).
//   admin  the admin dashboard builds the agent for the people of ONE
//          organisation: what that organisation may use (its grant, and the
//          app set up on this server) from its integration availability
//          (api/queries/orgIntegrationAvailability). The admin's own logins
//          and keys say nothing about that, so they are never read.

import { integrationAvailable, type AvailabilityRead } from '@/utils/integrationAvailability';
import { MICROSOFT_APP_IDS } from '@/utils/integrationFamilies';

// `agent-search` (Web Search) is a built-in platform capability with no
// per-org credentials — bypass the org-enabled gate so every agent can opt
// into it.
export const ALWAYS_AVAILABLE = new Set(['agent-search']);

const OUTLOOK_IDS = new Set(['outlook', 'outlook-readonly']);
const MICROSOFT_IDS = new Set(MICROSOFT_APP_IDS);

/** The flags of `GET /ai/user-settings` this filter reads; every one may be absent. */
export interface IntegrationAvailabilityStatus {
    orgEnabledIntegrations?: string[] | null;
    isGoogleUser?: boolean;
    isMicrosoftUser?: boolean;
    hasMicrosoftConnection?: boolean;
    /** Not in GET /ai/user-settings today: read only when a caller supplies it (Settings' Nextcloud status). */
    isNextcloudUser?: boolean;
    hasNextcloudAppPassword?: boolean;
    hasFirefliesKey?: boolean;
    hasYouTrackConfig?: boolean;
    hasGammaKey?: boolean;
    hasAfasConfig?: boolean;
    hasNmbrsConfig?: boolean;
    hasFrappeCrmConfig?: boolean;
    hasTwobaConfig?: boolean;
    hasFirebirdConfig?: boolean;
    hasVplanConfig?: boolean;
    hasSignRequestConfig?: boolean;
    hasN8nConfig?: boolean;
    hasLinkedInConfig?: boolean;
    linkedInConnected?: boolean;
}

/** The apps that run on a personal key or account of the person who uses them, and the flag that says it is there. */
const PERSONAL_CREDENTIAL: Readonly<Record<string, (s: IntegrationAvailabilityStatus) => boolean>> = {
    fireflies: s => !!s.hasFirefliesKey,
    youtrack: s => !!s.hasYouTrackConfig,
    gamma: s => !!s.hasGammaKey,
    'afas-profit': s => !!s.hasAfasConfig,
    nmbrs: s => !!s.hasNmbrsConfig,
    'frappe-crm': s => !!s.hasFrappeCrmConfig,
    twoba: s => !!s.hasTwobaConfig,
    firebird: s => !!s.hasFirebirdConfig,
    vplan: s => !!s.hasVplanConfig,
    signrequest: s => !!s.hasSignRequestConfig,
    n8n: s => !!s.hasN8nConfig,
    linkedin: s => !!s.hasLinkedInConfig || !!s.linkedInConnected,
};

interface CatalogItem { id: string; group?: string }

/**
 * How to decide. `user` (the default) reads the status argument; `unloaded`
 * says what a status that has not loaded yet means: `all` (the builder and the
 * skill editor: no gate to apply yet) or `none` (the legacy designer).
 * `admin` reads the chosen organisation's availability and ignores the status.
 */
export type AvailabilityMode =
    | { mode: 'user'; unloaded?: 'all' | 'none' }
    | { mode: 'admin'; availability: AvailabilityRead | null | undefined; platformAdmin: boolean };

/**
 * Apps in PERSONAL_CREDENTIAL whose flag is the ORGANISATION's set-up, not a
 * key of the person: n8n runs on the organisation's own instance (n8n_url_org_*).
 */
const ORG_CONFIGURED = new Set(['n8n']);

/** Whether `item` needs each person's own login or key (Google, Microsoft, Nextcloud, a personal API key). */
export function needsPersonalConnection(item: CatalogItem): boolean {
    if (ORG_CONFIGURED.has(item.id)) return false;
    return item.group === 'google' || item.group === 'microsoft' || item.group === 'nextcloud' || item.id in PERSONAL_CREDENTIAL;
}

function microsoftAvailable(item: CatalogItem, status: IntegrationAvailabilityStatus): boolean {
    // Microsoft apps borrow the Microsoft login just like Google's. Outlook
    // also runs off a Microsoft 365 connection made in Settings next to a
    // Google/Nextcloud login (the server lifts only the Outlook tools off
    // that vault credential), hence `hasMicrosoftConnection` for those two.
    if (OUTLOOK_IDS.has(item.id)) return !!status.isMicrosoftUser || !!status.hasMicrosoftConnection;
    return !!status.isMicrosoftUser;
}

function nextcloudAvailable(status: IntegrationAvailabilityStatus): boolean {
    // The org allow-list already ran. The Nextcloud login or app password is
    // only known when the caller passes it; without it there is nothing more to check.
    if (status.isNextcloudUser === undefined && status.hasNextcloudAppPassword === undefined) return true;
    return !!status.isNextcloudUser || !!status.hasNextcloudAppPassword;
}

function userAvailable(item: CatalogItem, status: IntegrationAvailabilityStatus): boolean {
    if (ALWAYS_AVAILABLE.has(item.id)) return true;
    const orgEnabled = status.orgEnabledIntegrations;
    if (orgEnabled && !orgEnabled.includes(item.id)) return false;
    if (item.group === 'google') return !!status.isGoogleUser;
    if (item.group === 'microsoft' || MICROSOFT_IDS.has(item.id)) return microsoftAvailable(item, status);
    if (item.group === 'nextcloud') return nextcloudAvailable(status);
    const personal = PERSONAL_CREDENTIAL[item.id];
    return personal ? personal(status) : true;
}

function adminAvailable(item: CatalogItem, how: Extract<AvailabilityMode, { mode: 'admin' }>): boolean {
    if (ALWAYS_AVAILABLE.has(item.id)) return true;
    return integrationAvailable(how.availability, item.id, { platformAdmin: how.platformAdmin }).available;
}

/**
 * The catalogue items the agent may be given. In user mode a null/undefined
 * status means "not loaded yet" (see AvailabilityMode `unloaded`); in admin
 * mode an unknown answer follows utils/integrationAvailability's fail policy
 * (open for a platform admin, closed for an organisation admin).
 */
export function filterAvailableIntegrations<T extends CatalogItem>(
    catalog: T[],
    integrationStatus?: IntegrationAvailabilityStatus | null,
    how: AvailabilityMode = { mode: 'user' },
): T[] {
    if (how.mode === 'admin') return catalog.filter(item => adminAvailable(item, how));
    if (!integrationStatus) return how.unloaded === 'none' ? [] : catalog;
    const status = integrationStatus;
    return catalog.filter(item => userAvailable(item, status));
}
