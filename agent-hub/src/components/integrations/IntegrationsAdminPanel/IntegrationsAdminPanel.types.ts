// Shared shapes of the IntegrationsAdminPanel state hooks.
import type { AdminOrganization } from '../../admin/org/userManagement/types';

export interface AdminMessage {
    type: 'success' | 'error';
    text: string;
}

export type { AdminOrganization };

export interface AdminMcpServer {
    id: string;
    name: string;
    description?: string;
    tools_cache?: unknown[];
    icon?: string;
}

export interface AgentSearchModeDefaults {
    max_results?: number;
    fetch_top_n?: number;
    max_tokens_markdown?: number;
    detail_level?: string;
}

export interface AgentSearchDefaults {
    mode: string;
    include_citations: boolean;
    web: AgentSearchModeDefaults;
    web_fast: AgentSearchModeDefaults;
}

export interface VoiceprintPatch {
    voiceprintMatchingEnabled?: boolean;
    pyannoteIdentifyThreshold?: number;
}
