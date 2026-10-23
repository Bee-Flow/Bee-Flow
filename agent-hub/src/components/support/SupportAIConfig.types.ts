/**
 * SupportAIConfig — Studio-style editor for the singleton Bee Flow Support
 * agent. Reuses AgentEditorUI (same component the Agent Studio uses) so the
 * look-and-feel is identical to the rest of the app, and reuses
 * MarkdownRenderer + tierMeta for the preview reply rendering.
 *
 * Mounts inside the admin "Support" tab as a sub-view. Loads the agent from
 * GET /api/support/agent, persists via PUT /api/support/agent, and previews
 * via POST /api/support/preview.
 */

/** The singleton support agent as GET /api/support/agent stores it. */
export interface SupportAgentRow {
    id: string;
    name?: string;
    avatar?: string;
    model?: string;
    description?: string;
    system_prompt?: string;
    starter_prompts?: string | string[];
    category_id?: string | null;
    config?: { knowledge_base_ids?: string[]; [key: string]: unknown };
}

/** The editor's working copy of that agent. */
export interface SupportAgentData {
    id: string;
    name: string;
    avatar: string;
    model: string;
    description: string;
    systemPrompt: string;
    starterPrompts: string[];
    categoryId: string | null;
    config: { knowledge_base_ids?: string[]; [key: string]: unknown };
}

/** A dry-run reply from POST /api/support/preview. */
export interface PreviewReply {
    modelTier?: string;
    escalated?: boolean;
    escalateReason?: string;
    content?: string;
    citations?: { title?: string }[];
}
