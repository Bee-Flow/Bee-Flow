/** Typen van de versiegeschiedenis (VersionHistory). Alleen types. */

/** Eén versie in de tijdlijn. */
export interface VersionEntry {
    id: string;
    version_number: number | string;
    created_at?: string | null;
    change_summary?: string | null;
}

/** Een gevangen fase van een oudere agentopname. */
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
    icon?: string;
    name?: string;
    parallel?: boolean;
    description?: string;
    color?: string;
    agents?: SnapshotPhaseAgent[];
}

/** De inhoud van een versie, zoals de server hem bewaarde (oude en nieuwe sleutels). */
export interface SnapshotBody {
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

/** Een geopende versie: het antwoord van de detailroute. */
export type PreviewVersion = { id?: string; snapshot?: SnapshotBody } & SnapshotBody;

/** Het ene woord dat een tekstveld in de voorvertoning krijgt. */
export interface PreviewField {
    label: string;
    value: string;
}

export interface PreviewToggle {
    label: string;
    value: boolean;
}

/**
 * Version History panel — reusable across all agent editors.
 * Shows a timeline of previous versions with restore capability.
 *
 * @param {object} props
 * @param {string} props.agentId - The agent ID
 * @param {() => void} [props.onRestore] - Called after a successful restore (a 2xx
 *   only); parent should reload agent data
 */
