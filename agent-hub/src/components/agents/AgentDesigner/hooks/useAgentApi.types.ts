// Types of hooks/useAgentApi.ts.
import type { DesignerAgent } from '../AgentListSidebar';
import type useAgentState from './useAgentState';
import type { DesignerMessage } from './useAgentState';

export type { DesignerAgent, DesignerMessage };

/** The designer's state bag, as the API hook reads and writes it. */
export type ApiState = ReturnType<typeof useAgentState>;

export interface ApiOptions {
    systemMode?: boolean;
    initialAgentId?: string | null;
    /** The admin dashboard's chosen organisation, sent as `orgId` with the agents list and the categories. */
    orgId?: string | null;
}

/** The fields `PUT/POST /agents` receives from the designer. */
export interface AgentSaveBody {
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    toolParams: Record<string, unknown>;
    model: string | null;
    starterPrompts: string[];
    avatar: string;
    workspaceEnabled: number;
    embedEnabled: boolean;
    config: Record<string, unknown>;
    categoryId?: string | null;
    /** On create only: the organisation the admin dashboard narrowed the list to (POST /agents trusts it from a platform admin). */
    organizationId?: string;
}
