// The Agent Hub designer panel's working copy of a stored agent row.
import type { AgentFormData } from './AgentEditorUI';
import type { PanelAgent } from './AgentDesignerPanel.types';
import { storedConfig, storedFlag } from './AgentDesigner/storedFlag';

/** A list column that may come back as JSON text (an older store) or as an array. */
function storedList(value: unknown): string[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed: unknown = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * The form for an agent row. The on/off columns are Postgres booleans (the
 * integer spelling of an older row is still read; a missing value takes the
 * column default), and the config is kept whole so a save carries every key
 * the panel does not edit.
 */
export function panelFormFromAgent(agent: PanelAgent): AgentFormData {
    return {
        name: agent.name || '',
        description: agent.description || '',
        avatar: agent.avatar || '',
        systemPrompt: agent.system_prompt || '',
        tools: agent.tools || [],
        toolParams: agent.tool_params || {},
        model: agent.model || '',
        starterPrompts: storedList(agent.starter_prompts),
        workspaceEnabled: storedFlag(agent.workspace_enabled, false),
        copyEnabled: storedFlag(agent.copy_enabled, true),
        isPublished: storedFlag(agent.is_published, false),
        embedEnabled: storedFlag(agent.embed_enabled, false),
        organizationId: agent.organization_id || '',
        sharedGroups: storedList(agent.shared_groups),
        categoryId: agent.category_id || '',
        config: storedConfig(agent.config) as AgentFormData['config'],
    };
}
