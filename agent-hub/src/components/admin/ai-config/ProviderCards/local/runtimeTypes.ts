// Shapes shared by the self-hosted runtime card and its parts.

/** One entry of GET /ai/local-runtimes. */
export interface RuntimeInfo {
    type?: string;
    label?: string;
    defaultUrl?: string;
    docsUrl?: string;
    description?: string;
    canPull?: boolean;
}

/** One model a runtime reports serving. */
export interface ProbeModel {
    id: string;
    name?: string;
    /** Always set: the server describes every served model (core/providers/localModels.js). */
    cat: string;
}

/** What "Test connection" answers: a failure carries a reason, a success lists what it serves. */
export type ProbeData =
    | { ok: false; error?: string | null; version?: string | null; modelCount?: number; models?: ProbeModel[] }
    | { ok: true; error?: string | null; version?: string | null; modelCount?: number; models: ProbeModel[] };

/** What the connect form hands to onConnect. */
export interface ConnectRequest {
    type?: string;
    name?: string;
    url?: string;
    apiKey?: string;
}

/** A provider record from GET /ai/providers. */
export interface RuntimeProvider {
    id: string;
    name?: string;
    type?: string;
    url?: string;
}

/** The tier a starter model is suggested for. */
export type StarterTier = 'fast' | 'standard' | 'thinking' | 'deep_thinking';

/** One entry of GET /ai/local-runtimes/models. */
export interface StarterModel {
    model: string;
    label?: string;
    tier?: StarterTier;
    vram?: string;
    note?: string;
}

/** A progress frame of a model download. */
export interface PullProgress {
    status: string;
    pct: number | null;
}
