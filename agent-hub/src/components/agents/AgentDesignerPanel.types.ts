import type { ToolParamConfig, AgentFormData } from './AgentEditorUI';
import type { HubUser } from '../../AgentHub/useAgentHubData';
import type React from 'react';

/**
 * AgentDesignerPanel - Editing panel for agents within Agent Hub
 * Receives selected agent from parent, manages editing state
 */
/** An agent as the API stores it (snake_case; some columns are JSON text). */
export type PanelAgent = {
    id: string;
    name?: string;
    description?: string;
    avatar?: string;
    system_prompt?: string;
    tools?: string[];
    tool_params?: Record<string, Record<string, ToolParamConfig>>;
    model?: string | null;
    starter_prompts?: string | string[];
    workspace_enabled?: number;
    copy_enabled?: number;
    is_published?: number;
    embed_enabled?: number;
    organization_id?: string | null;
    shared_groups?: string | string[];
    category_id?: string | null;
    config?: AgentFormData['config'] | null;
};

export interface AgentDesignerPanelProps {
    agent?: PanelAgent | null;
    onSave?: (saved?: PanelAgent | null) => void;
    user?: HubUser | null;
    onClose: React.MouseEventHandler<HTMLButtonElement>;
    onDelete?: () => void;
}
