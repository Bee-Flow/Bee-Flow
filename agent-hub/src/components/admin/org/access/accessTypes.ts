import { Layers, Settings, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** One capability row, as the group-access / org-availability payloads carry it. */
export interface AccessCapability {
    id: string;
    name: string;
    kind: string;
    category?: string;
    description?: string;
    groupScoped?: boolean;
}

/** One group row of the group-access payload. */
interface AccessGroup {
    id: string;
    name: string;
    granted?: string[];
}

/** GET .../group-access and .../org-availability (the fields these screens read). */
export interface AccessData {
    orgId?: string | null;
    mode?: string;
    ceiling?: string[];
    capabilities?: AccessCapability[];
    everyone?: string[];
    groups?: AccessGroup[];
    betaGoverned?: boolean;
    unrestricted?: boolean;
    available?: string[];
    /**
     * Per integration row: can this server serve it at all (an OAuth app, a key,
     * a binding)? Left out when the server could not tell; then nothing is marked.
     */
    serverConfigured?: Record<string, { serverConfigured: boolean; reason?: string }>;
}

/** True only when the server said this integration is not set up on it; unknown is not "not set up". */
export function notSetUpOnServer(data: Pick<AccessData, 'serverConfigured'> | null | undefined, capId: string): boolean {
    return data?.serverConfigured?.[capId]?.serverConfigured === false;
}

/** Save / load status shown next to the heading. */
export interface AccessMessage {
    type: 'ok' | 'error';
    text: string;
}

export interface AccessKindSection {
    kind: string;
    labelKey: string;
    label: string;
    icon: LucideIcon;
}

/**
 * The kinds a capability list groups by, in display order. MCP servers are
 * integrations (kind 'integration', category 'MCP servers'), so they have no
 * group of their own.
 */
export const ACCESS_KIND_SECTIONS: readonly AccessKindSection[] = [
    { kind: 'core', labelKey: 'admin_org.access_matrix_features', label: 'Features', icon: Layers },
    { kind: 'beta', labelKey: 'admin_org.access_matrix_beta_features', label: 'Beta features', icon: Sparkles },
    { kind: 'integration', labelKey: 'admin_org.access_matrix_integrations', label: 'Integrations', icon: Settings },
];

/**
 * The integration categories whose label is a product name and stays as it is
 * in every language, and the translated label of the others. A category the
 * map does not know (an MCP server's, a custom integration's) shows as sent.
 */
const CATEGORY_LABELS: Readonly<Record<string, readonly [key: string, fallback: string] | null>> = {
    'Google Workspace': null,
    'Microsoft 365': null,
    Nextcloud: null,
    'AI & Media': ['admin_connections.category_ai_media', 'AI & media'],
    Developer: ['admin_connections.category_developer', 'Developer tools'],
    Automation: ['admin_connections.category_automation', 'Automation'],
    Productivity: ['admin_connections.category_productivity', 'Productivity'],
    Health: ['admin_connections.category_health', 'Health'],
    Social: ['admin_connections.category_social', 'Social'],
    'MCP servers': ['admin_platform.access_category_mcp', 'MCP servers'],
    'Custom integrations': ['admin_platform.access_category_custom', 'Custom integrations'],
};

/** The sub-heading of one integration category (the provider for Google and Microsoft, so two "Calendar" rows are told apart). */
export function integrationCategoryLabel(t: (key: string, fallback: string) => string, category: string): string {
    const entry = CATEGORY_LABELS[category];
    return entry ? t(entry[0], entry[1]) : category;
}

/** Capabilities in runs of one category, in the order they come (the caller sorts by category first). */
export function byCategory(caps: readonly AccessCapability[]): { category: string; caps: AccessCapability[] }[] {
    const runs: { category: string; caps: AccessCapability[] }[] = [];
    for (const cap of caps) {
        const category = cap.category || '';
        const last = runs[runs.length - 1];
        if (last && last.category === category) last.caps.push(cap);
        else runs.push({ category, caps: [cap] });
    }
    return runs;
}
