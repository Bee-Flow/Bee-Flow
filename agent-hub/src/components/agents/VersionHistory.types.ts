/**
 * Version History panel — reusable across all agent editors.
 * Shows a timeline of previous versions with restore capability.
 *
 * @param {object} props
 * @param {string} props.agentId - The agent ID
 * @param {() => void} [props.onRestore] - Called after a successful restore (a 2xx
 *   only); parent should reload agent data
 */
export interface VersionHistoryProps {
    agentId: string;
    onRestore?: (() => Promise<void>) | (() => void);
}

export interface SnapshotPhaseAgent {
    name?: string;
    role?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    hiveMindAccess?: string;
    tools?: string[];
    system_prompt?: string;
    systemPrompt?: string;
}

export interface SnapshotPhase {
    id?: string;
    name?: string;
    icon?: string;
    parallel?: boolean;
    description?: string;
    color?: string;
    agents?: SnapshotPhaseAgent[];
}

export interface AgentSnapshot {
    name?: string;
    description?: string;
    model?: string;
    icon?: string;
    type?: string;
    enabled?: boolean;
    workspace_enabled?: unknown;
    embed_enabled?: unknown;
    copy_enabled?: unknown;
    threads_enabled?: unknown;
    sandbox_mode?: unknown;
    system_prompt?: string;
    systemPrompt?: string;
    tools?: string[];
    starter_prompts?: string | string[];
    config?: string | Record<string, unknown>;
    phases?: string | SnapshotPhase[];
}

export interface VersionPreview extends AgentSnapshot {
    id?: string;
    snapshot?: AgentSnapshot;
}
