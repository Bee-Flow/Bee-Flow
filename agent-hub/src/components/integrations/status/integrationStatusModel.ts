// The "Integration status" page of one organisation, as data: for each
// integration family and each catalogue integration, its state for the CHOSEN
// organisation (api/queries/orgIntegrationAvailability) and the one place
// where that state can change. No React, no network, so the rules are tested
// on their own (integrationStatusModel.test.ts).
//
// The states, in the order an admin works through them:
//   available       the organisation has it; nothing to do
//   per_user        the organisation has it, and each member connects their own
//                   account or key in Settings > Connections
//   not_granted     the organisation's access menu leaves it out: Access
//   not_in_plan     the organisation's plan or licence leaves it out
//   not_configured  nobody set it up on this server yet: the platform page
//                   that holds its credentials (a platform admin only)
//   module_off      a platform module is switched off on this server
//   not_bound       the organisation is not connected to a Nextcloud
//   unknown         no definite answer (still loading, refused, or a plan
//                   that could not be read)

import { familyAvailable, integrationAvailable, type AvailabilityRead, type AvailabilityVerdict } from '@/utils/integrationAvailability';
import type { IntegrationFamily, UnavailableReason } from '@/api/queries/orgIntegrationAvailability';
import { CATEGORY_ORDER, INTEGRATION_CATALOG, type IntegrationEntry } from '@/config/integrationCatalog';

export type IntegrationState =
    | 'available' | 'per_user' | 'not_granted' | 'not_in_plan' | 'not_configured' | 'module_off' | 'not_bound' | 'unknown';

/**
 * Where a state is changed: an app address under /app (admin rows, the
 * viewer's own Settings). `platformOnly` targets are rows only a platform
 * admin can open; anyone else gets the sentence without the link.
 */
export interface StatusTarget {
    path: string;
    labelKey: string;
    labelFallback: string;
    platformOnly: boolean;
}

export interface StatusRow {
    id: string;
    label: string;
    description?: string;
    state: IntegrationState;
    /** The reason the server gave, for the sentence under a row. */
    reason?: UnavailableReason;
    /** Where to go about it; null when there is nothing to do or nowhere this viewer may go. */
    target: StatusTarget | null;
}

export interface StatusGroup {
    category: string;
    rows: StatusRow[];
    /** Rows the organisation can use (available or per_user). */
    usable: number;
}

/**
 * The catalogue integrations a member connects with their own account or key
 * in Settings > Connections: once the organisation has one, nothing more is
 * set up at the organisation level.
 */
export const PER_USER_INTEGRATION_IDS: ReadonlySet<string> = new Set([
    'fireflies', 'nmbrs', 'afas-profit', 'frappe-crm', 'twoba', 'firebird', 'vplan', 'signrequest', 'youtrack', 'gamma',
    'github', 'linkedin', 'withings', 'scaleway-billing',
]);

/** The families the page opens with, each with its display name. */
const STATUS_FAMILIES: ReadonlyArray<{ id: IntegrationFamily; label: string }> = [
    { id: 'google', label: 'Google Workspace' },
    { id: 'microsoft', label: 'Microsoft 365' },
    { id: 'nextcloud', label: 'Nextcloud' },
    { id: 'github', label: 'GitHub' },
    { id: 'n8n', label: 'n8n' },
    { id: 'maps', label: 'Google Maps' },
    { id: 'mcp', label: 'MCP servers' },
];

/** Families whose members connect their own account (a sign-in or a connection in Settings). */
const PER_USER_FAMILIES: ReadonlySet<IntegrationFamily> = new Set(['google', 'microsoft']);

const T = (path: string, labelKey: string, labelFallback: string, platformOnly: boolean): StatusTarget =>
    ({ path, labelKey, labelFallback, platformOnly });

export const TARGETS = {
    access: T('admin/access/grants', 'admin_nav.access', 'Access', false),
    licence: T('admin/organisation/license', 'admin_nav.license_usage', 'Licence & usage', false),
    /** Self-hosted: the plan is the server licence (the organisation licence row is cloud only). */
    serverLicence: T('admin/licenses/server', 'admin_nav.server_licence', 'Server licence', true),
    connections: T('settings/integrations', 'admin_connections.target_connections', 'Settings › Connections', false),
    nextcloud: T('admin/organisation/nextcloud-sync', 'admin_nav.nextcloud', 'Nextcloud', false),
    /**
     * The same row for an organisation that is not bound yet: it is there only
     * for a platform admin (the pairing), so nobody else gets a link to it.
     */
    ncPairing: T('admin/organisation/nextcloud-sync', 'admin_nav.nextcloud', 'Nextcloud', true),
    githubSync: T('admin/organisation/github-sync', 'admin_nav.github_sync', 'GitHub sync', false),
    mcp: T('admin/organisation/mcp', 'admin_nav.mcp_servers', 'MCP servers', false),
    signIn: T('admin/security/sso', 'admin_nav.sso', 'Sign-in & SSO', true),
    platformServices: T('admin/integrations/connected-apps', 'admin_nav.platform_services', 'Platform services', true),
    transcription: T('admin/integrations/transcription', 'admin_nav.ps_transcription', 'Transcription', true),
    aiProviders: T('admin/ai-config/providers', 'admin_nav.ai_config', 'AI configuration', true),
    retrieval: T('admin/ai-config/retrieval', 'admin_nav.ai_retrieval', 'Search & retrieval', true),
    featureSwitches: T('admin/licenses/features', 'admin_nav.licence_features', 'Licence & features', true),
} as const satisfies Record<string, StatusTarget>;

/** Where the credentials of an integration that is not set up on this server live. */
const SETUP_TARGET_BY_ID: Readonly<Record<string, StatusTarget>> = {
    maps: TARGETS.platformServices,
    linkedin: TARGETS.platformServices,
    withings: TARGETS.platformServices,
    transcription: TARGETS.transcription,
    'image-gen': TARGETS.aiProviders,
    'video-gen': TARGETS.aiProviders,
    'music-gen': TARGETS.aiProviders,
    elevenlabs: TARGETS.aiProviders,
    'agent-search': TARGETS.retrieval,
};

const SIGN_IN_CATEGORIES: ReadonlySet<string> = new Set(['Google Workspace', 'Microsoft 365']);

function setupTargetOf(id: string, category: string | null): StatusTarget {
    if (Object.hasOwn(SETUP_TARGET_BY_ID, id)) return SETUP_TARGET_BY_ID[id];
    if (category && SIGN_IN_CATEGORIES.has(category)) return TARGETS.signIn;
    return TARGETS.platformServices;
}

const FAMILY_SETUP_TARGET: Partial<Record<IntegrationFamily, StatusTarget>> = {
    google: TARGETS.signIn,
    microsoft: TARGETS.signIn,
    maps: TARGETS.platformServices,
};

/** Where an available family is configured further, if anywhere. */
const FAMILY_HOME: Partial<Record<IntegrationFamily, StatusTarget>> = {
    nextcloud: TARGETS.nextcloud,
    github: TARGETS.githubSync,
    mcp: TARGETS.mcp,
};

/** What the page knows about the server beyond the availability answer. */
export interface StatusOptions {
    /** A self-hosted server: an organisation's plan is the server licence. */
    selfHosted?: boolean;
}

/** The state a verdict means; `perUser` turns an available integration into one each member connects. */
function stateOf(verdict: AvailabilityVerdict, perUser: boolean): IntegrationState {
    if (verdict.unknown) return 'unknown';
    if (verdict.available) return perUser ? 'per_user' : 'available';
    switch (verdict.reason) {
        case 'not_granted_to_org': return 'not_granted';
        case 'not_in_plan': return 'not_in_plan';
        case 'not_configured': return 'not_configured';
        case 'module_off': return 'module_off';
        case 'not_bound': return 'not_bound';
        default: return 'not_granted';
    }
}

/** The target for a state, given where the integration is set up and where it lives when available. */
function targetFor(state: IntegrationState, setup: StatusTarget, home: StatusTarget | null, opts: StatusOptions): StatusTarget | null {
    switch (state) {
        case 'per_user': return TARGETS.connections;
        case 'available': return home;
        case 'not_granted': return TARGETS.access;
        case 'not_in_plan': return opts.selfHosted ? TARGETS.serverLicence : TARGETS.licence;
        case 'not_configured': return setup;
        case 'module_off': return TARGETS.featureSwitches;
        case 'not_bound': return TARGETS.ncPairing;
        default: return null;
    }
}

/** Drop a target the viewer cannot open. */
function visibleTo(target: StatusTarget | null, platformAdmin: boolean): StatusTarget | null {
    return target && (!target.platformOnly || platformAdmin) ? target : null;
}

/** One row per family of STATUS_FAMILIES. */
export function familyStatusRows(read: AvailabilityRead | null | undefined, platformAdmin: boolean, opts: StatusOptions = {}): StatusRow[] {
    const viewer = { platformAdmin };
    return STATUS_FAMILIES.map(({ id, label }) => {
        const verdict = familyAvailable(read, id, viewer);
        const state = stateOf(verdict, PER_USER_FAMILIES.has(id));
        const setup = FAMILY_SETUP_TARGET[id] ?? TARGETS.platformServices;
        const target = visibleTo(targetFor(state, setup, FAMILY_HOME[id] ?? null, opts), platformAdmin);
        return { id, label, state, ...(verdict.reason ? { reason: verdict.reason } : {}), target };
    });
}

function appRow(entry: IntegrationEntry, read: AvailabilityRead | null | undefined, platformAdmin: boolean, opts: StatusOptions): StatusRow {
    const verdict = integrationAvailable(read, entry.id, { platformAdmin });
    const state = stateOf(verdict, PER_USER_INTEGRATION_IDS.has(entry.id));
    const target = visibleTo(targetFor(state, setupTargetOf(entry.id, entry.category), null, opts), platformAdmin);
    return {
        id: entry.id, label: entry.label, description: entry.description, state,
        ...(verdict.reason ? { reason: verdict.reason } : {}), target,
    };
}

const USABLE: ReadonlySet<IntegrationState> = new Set(['available', 'per_user']);

/** Is this row something the organisation can use now? */
function isUsable(row: StatusRow): boolean {
    return USABLE.has(row.state);
}

/**
 * The catalogue integrations by category, in the admin UIs' category order.
 * `catalog` defaults to the client catalogue (a test passes its own).
 */
export function appStatusGroups(
    read: AvailabilityRead | null | undefined,
    platformAdmin: boolean,
    catalog: readonly IntegrationEntry[] = INTEGRATION_CATALOG,
    opts: StatusOptions = {},
): StatusGroup[] {
    const byCategory = new Map<string, StatusRow[]>();
    for (const entry of catalog) {
        const rows = byCategory.get(entry.category) ?? [];
        rows.push(appRow(entry, read, platformAdmin, opts));
        byCategory.set(entry.category, rows);
    }
    const order = [...CATEGORY_ORDER.filter(c => byCategory.has(c)), ...[...byCategory.keys()].filter(c => !CATEGORY_ORDER.includes(c))];
    return order.map(category => {
        const rows = byCategory.get(category) ?? [];
        return { category, rows, usable: rows.filter(isUsable).length };
    });
}

/** Nothing on the page is usable and every answer is definite: the empty state. */
export function nothingAvailable(families: readonly StatusRow[], groups: readonly StatusGroup[]): boolean {
    const all = [...families, ...groups.flatMap(g => g.rows)];
    return all.length > 0 && all.every(r => !isUsable(r) && r.state !== 'unknown');
}

/**
 * The app address of a target: /app/<path>, and for an admin row the
 * dashboard's organisation choice (?org=) kept, so Access opens on the same
 * organisation.
 */
export function targetHref(target: StatusTarget, search: string): string {
    const url = `/app/${target.path}`;
    if (!target.path.startsWith('admin/')) return url;
    const org = new URLSearchParams(search).get('org');
    return org ? `${url}?org=${encodeURIComponent(org)}` : url;
}

/**
 * Which configuration cards the page draws below the overview: the
 * organisation's Nextcloud tools and n8n, each only where the CHOSEN
 * organisation has it (the availability fail policy decides an unknown answer).
 */
export function integrationCards(read: AvailabilityRead | null | undefined, platformAdmin: boolean): { showN8n: boolean; showNc: boolean } {
    const viewer = { platformAdmin };
    return {
        showN8n: familyAvailable(read, 'n8n', viewer).available,
        showNc: familyAvailable(read, 'nextcloud', viewer).available,
    };
}
