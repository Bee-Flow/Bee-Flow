/** Shapes shared by the chat-model-tier state hooks. */

/** One standard tier's settings, as /ai/config/chat-models stores them. */
export interface TierSettings {
    modelId: string;
    label?: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    reasoningSummary?: boolean | string;
    budgetTokens?: number;
    verbosity?: string;
    [key: string]: unknown;
}

/** Tier key ('fast', 'standard', …) → its settings. */
export type TierConfig = Record<string, TierSettings>;

/** An org-defined tier on top of the standard ones. */
export interface CustomTier {
    id: string;
    label: string;
    icon?: string;
    description?: string;
    modelId: string;
    euModelId?: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    reasoningSummary?: boolean;
    budgetTokens?: number;
    verbosity?: string;
    allowedTaskTypes?: string[];
    /** Local-only: the card was just added, show the label/id editor expanded. */
    _isNew?: boolean;
    [key: string]: unknown;
}

/** A save's outcome, shown next to its section. */
export interface StatusMessage {
    type: 'success' | 'error' | 'warning';
    text: string;
}

/** One model of the provider catalogue, as the admin model list sends it. */
export interface CatalogModel {
    id: string;
    providerName?: string;
    /** Category the server stamped from the provider's own model list. */
    cat?: string;
    local?: boolean;
    reasoning?: boolean;
    efforts?: string[];
    [key: string]: unknown;
}

/** Show `message` now and clear it after `ms`. */
export function flash(set: (m: StatusMessage | null) => void, message: StatusMessage, ms: number) {
    set(message);
    setTimeout(() => set(null), ms);
}
