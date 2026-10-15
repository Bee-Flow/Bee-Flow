// Shapes of the AI-tool graph: the step as the canvas reads it, the tool
// state a step carries, and the nodes/edges buildAiToolGraph emits.

export interface AiStepLike {
    id: string;
    type?: string;
    tools?: string[];
    allowTools?: boolean;
    parentId?: string;
    [key: string]: unknown;
}

export type AiStepFull = AiStepLike & { agentId?: unknown; skillIds?: unknown; knowledgeBaseIds?: unknown; prompt?: string };

export interface AiDefinitionLike {
    steps?: AiStepLike[];
    [key: string]: unknown;
}

export interface ToolMeta {
    label: string;
    description?: string | null;
    integrationId?: string | null;
}

export interface ToolState {
    mode: 'none' | 'explicit' | 'all';
    tools: string[];
}

export interface AiToolFlowNode {
    id: string;
    type?: string;
    position?: { x: number; y: number };
    parentId?: string;
    extent?: unknown;
    data?: { step?: AiStepLike };
}

export interface AiToolNode {
    id: string;
    type: string;
    position: { x: number; y: number };
    draggable: boolean;
    deletable: boolean;
    selectable: boolean;
    parentId?: string;
    extent?: unknown;
    data: {
        stepId: string;
        tool: string | null;
        all: boolean;
        label: string;
        description: string | null;
        integrationId: string | null;
        onDetach: ((stepId: string, tool: string) => void) | null;
    };
}

export interface AiToolEdge {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    type: string;
    deletable: boolean;
    selectable: boolean;
    focusable: boolean;
}
