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
    /** The on/off columns: Postgres BOOLEAN (true/false); an older row may still hold 1/0. Read them with storedFlag. */
    workspace_enabled?: boolean | number;
    copy_enabled?: boolean | number;
    is_published?: boolean | number;
    embed_enabled?: boolean | number;
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
