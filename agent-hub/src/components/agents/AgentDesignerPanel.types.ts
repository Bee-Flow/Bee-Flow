// Types of AgentDesignerPanel, kept apart so the panel stays under the file budget.
import type { AgentCategory } from './AgentStudio/agentCardFacts';

/** An organisation or group row the sharing controls list. */
export interface EditorOrgEntry {
    id: string;
    name?: string;
    description?: string | null;
    [key: string]: unknown;
}

/** One parameter of a tool as the legacy panel stores it: fixed to a value or left to the caller. */
export interface DesignerToolParamConfig {
    fixed?: boolean;
    value?: unknown;
}

/** The legacy panel's form body (see saveAgent for the wire shape). */
export interface DesignerFormData {
    name: string;
    description: string;
    avatar: string;
    systemPrompt: string;
    tools: string[];
    toolParams: Record<string, Record<string, DesignerToolParamConfig>>;
    model: string;
    starterPrompts: string[];
    workspaceEnabled: boolean;
    copyEnabled: boolean;
    isPublished: boolean;
    embedEnabled: boolean;
    organizationId: string;
    sharedGroups: string[];
    categoryId: string;
    config: Record<string, unknown>;
}

/** An agent row as this panel reads it. */
export interface DesignerPanelAgent {
    id?: string | null;
    name?: string | null;
    description?: string | null;
    avatar?: string | null;
    system_prompt?: string | null;
    tools?: string[] | null;
    tool_params?: Record<string, Record<string, DesignerToolParamConfig>> | null;
    model?: string | null;
    starter_prompts?: string | string[] | null;
    workspace_enabled?: number;
    copy_enabled?: number;
    is_published?: number;
    embed_enabled?: number;
    organization_id?: string | null;
    shared_groups?: string | string[] | null;
    category_id?: string | null;
    config?: string | Record<string, unknown> | null;
    [key: string]: unknown;
}

export type OrgRow = EditorOrgEntry;

export interface AgentDesignerPanelProps {
    agent: DesignerPanelAgent | null;
    onClose?: () => void;
    onSave?: (agent?: DesignerPanelAgent | null) => void;
    onDelete?: () => void;
    user?: { betaFeatures?: unknown; [key: string]: unknown } | null;
}

/** The props the panel passes to the editor (AgentEditorUI.jsx). */
export interface AgentEditorUIFormProps {
    data: DesignerFormData;
    onChange: (field: string, value: unknown) => void;
    availableModels: unknown[];
    hasKnowledge: boolean;
    hasSkills: boolean;
    user: { betaFeatures?: unknown; [key: string]: unknown } | null;
    agentId: string | null | undefined;
    API_BASE: string;
    organizations: EditorOrgEntry[];
    groups: EditorOrgEntry[];
    categories: AgentCategory[];
    onCreateCategory: (name: string) => unknown;
    urlSyncKey: string;
}
