import type { ModelEntry } from '../../api/modelMeta';
import type { AppUserLike } from '../projects/workspace/types';
import type { ModelTierMap } from '../../api/queries/modelTiers';

/**
 * AgentEditorUI - Reusable presentational component for editing agents
 * 
 * @param {Object} data - The agent data (name, description, systemPrompt, etc.)
 * @param {Function} onChange - Handler for field updates (field, value) => void
 * @param {Array} components - List of available tool components
 * @param {Array} availableModels - List of available LLM models
 * @param {boolean} isSystem - Whether this is a system agent (read-only flags etc)
 * @param {boolean} hasKnowledge - Whether to show the Knowledge tab (requires persistent ID)
 * @param {string} agentId - The ID of the agent (required for KnowledgePanel)
 * @param {string} API_BASE - Base URL for API calls (required for KnowledgePanel)
 */
/** One fixed (or free) parameter of a tool, as the designer stores it. */
export interface ToolParamConfig {
    fixed?: boolean;
    value?: unknown;
}

/** The editor's working copy of an agent. */
export interface AgentFormData {
    name: string;
    description: string;
    avatar: string;
    systemPrompt: string;
    /** The stored snake_case spelling, read when `systemPrompt` is empty. */
    system_prompt?: string;
    tools: string[];
    toolParams: Record<string, Record<string, ToolParamConfig>>;
    model: string;
    starterPrompts: string[];
    workspaceEnabled: boolean;
    copyEnabled: boolean;
    isPublished: boolean;
    embedEnabled: boolean;
    disableExternalTools?: boolean;
    strictKnowledge?: boolean;
    includeSourceReferences?: boolean;
    organizationId: string;
    sharedGroups: string[];
    categoryId: string;
    config: { attachedSkillIds?: string[]; [key: string]: unknown };
}

/**
 * What the editor reads of an agent. It guards every field itself (`data.name || ''`,
 * `data.sharedGroups || []`, …), so a caller that only has some of them (the
 * support agent) passes a part.
 */
export type AgentEditorData = Partial<Omit<AgentFormData, 'categoryId'>> & { categoryId?: string | null };

export interface EditorOrganization { id: string; name?: string }

export interface EditorGroup { id: string; name?: string; description?: string; organizationId?: string }

export interface EditorCategory { id: string; name?: string; icon?: string }

export interface AgentEditorUIProps {
    data: AgentEditorData;
    onChange: (field: string, value: unknown) => void;
    availableModels?: ModelEntry[];
    user?: AppUserLike | null;
    organizations?: EditorOrganization[];
    groups?: EditorGroup[];
    categories?: EditorCategory[];
    onCreateCategory?: (name: string) => void;
    isSystem?: boolean;
    hasKnowledge?: boolean;
    hasSkills?: boolean;
    agentId?: string | null;
    API_BASE: string;
    urlSyncKey?: string | null;
    modelTiers?: ModelTierMap | null;
}
