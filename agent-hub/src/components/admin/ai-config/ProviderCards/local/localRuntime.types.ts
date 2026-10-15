// Shapes shared by the self-hosted runtime cards (LocalModelsCard, RuntimeRow,
// AddRuntimeForm, ProbeResult). They describe what localRuntimeApi.js returns.

import type { TIER_LABELS } from './localRuntimeApi';
import type { CAT_COLORS } from '../../../../../utils/modelMeta';

/** One entry of GET /ai/local-runtimes (the catalogue of runtime flavours). */
export interface LocalRuntime {
    type: string;
    label?: string;
    defaultUrl?: string;
    description?: string;
    docsUrl?: string;
    canPull?: boolean;
}

/** One entry of GET /ai/local-runtimes/models (the curated Ollama starter list). */
export interface StarterModel {
    model: string;
    label: string;
    tier?: keyof typeof TIER_LABELS;
    vram: string;
    note: string;
}

/** One connected runtime: a generic /ai/providers record of a self-hosted type. */
export interface LocalProvider {
    id: string;
    type: string;
    name: string;
    url: string;
}

/** A model id reported by a runtime during a probe. */
export interface ProbedModel {
    id: string;
    cat: keyof typeof CAT_COLORS;
}

/** Outcome of "Test connection" (testRuntime): a reachable runtime lists its models. */
export type ProbeOutcome =
    | {
        ok: true;
        error?: string;
        version?: string;
        modelCount: number;
        models: ProbedModel[];
    }
    | {
        ok: false;
        error?: string;
        modelCount?: number;
        models?: ProbedModel[];
    };

/** A runtime that answered the autodetect scan. */
export interface DetectedRuntime {
    type: string;
    label: string;
    url: string;
    modelCount: number;
    alreadyConfigured?: boolean;
}

/** Outcome of the autodetect scan (detectRuntimes). */
export interface DetectOutcome {
    found: DetectedRuntime[];
    probed: number;
    error?: string;
}

/** Payload handed to connectRuntime. */
export interface RuntimeConnectInput {
    type: string;
    name: string;
    url: string;
    apiKey: string;
}
