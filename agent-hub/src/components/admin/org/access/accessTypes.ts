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
