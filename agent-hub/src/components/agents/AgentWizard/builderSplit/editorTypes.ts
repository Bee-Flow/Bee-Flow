/** Shapes of the agent row and the wizard plan the editor state is seeded from. */
import type { ReactNode } from 'react';

/** The `config` column of an agent row; every field may be missing. */
export interface EditorAgentConfig {
    memoryEnabled?: boolean;
    useGeneralMemory?: boolean;
    attachedSkillIds?: string[];
    enabledIntegrations?: string[] | null;
    knowledge_base_ids?: string[];
    tools?: Record<string, unknown> | null;
    strictKnowledge?: boolean;
    includeSourceReferences?: boolean;
    allowCopy?: boolean;
    disableExternalTools?: boolean;
    bubbleColor?: string;
    bubblePosition?: string;
    bubbleIcon?: string;
    avatar?: string | null;
    wizard?: { primaryKbId?: string | null } | null;
    [key: string]: unknown;
}

/** An agent row as the editor receives and re-reads it from the server. */
export interface EditorAgent {
    id?: string | null;
    name?: string;
    description?: string;
    system_prompt?: string;
    model?: string;
    category_id?: string | null;
    is_published?: number | boolean;
    embed_enabled?: number | boolean;
    shared_groups?: string[] | string | null;
    updated_at?: string | number | null;
    rev?: number | null;
    persona?: { language?: string | null } | null;
    config?: EditorAgentConfig | null;
    [key: string]: unknown;
}

/** What the wizard hands over as a first plan. */
export interface EditorPlan {
    name?: string;
    description?: string;
    systemPrompt?: string;
    avatar?: string;
}

export type NavigateFn = ((path: string) => void) | null;
export type HeaderExtras = ReactNode;
