// The three best-effort sources behind the Apps picker (useAppsCatalog): n8n
// workflows, connected MCP servers and Reusable Steps published "in chat".
// A 403/404 (beta off, nothing configured), a non-ok answer or a network
// failure means "this source contributes no apps", never an exception, exactly
// like the effect these replace.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
export interface N8nWorkflowSource {
    slug: string;
    name: string;
    description?: string;
}

export interface McpServerSource {
    id: string;
    name: string;
    toolCount?: number;
    allConfigured?: boolean;
    icon?: string;
}

/** A Reusable Step the user exposed to chat. */
export interface ExposedStepSource {
    id: string;
    title?: string;
    description?: string;
    category?: string;
    icon?: string | null;
}

export interface N8nWorkflow extends N8nWorkflowSource {
    enabled?: boolean;
    allowKbIngestion?: boolean;
}

const EMPTY_WORKFLOWS: N8nWorkflow[] = [];
const EMPTY_SERVERS: McpServerSource[] = [];
const EMPTY_STEPS: ExposedStepSource[] = [];

interface CatalogBody { workflows?: N8nWorkflow[]; servers?: McpServerSource[]; tools?: ExposedStepSource[] }

async function readJson(url: string): Promise<CatalogBody | null> {
    try {
        const r = await authFetch(url);
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

const appsCatalogKeys = {
    n8n: ['apps-catalog', 'n8n'] as const,
    mcp: ['apps-catalog', 'mcp-servers'] as const,
    steps: ['apps-catalog', 'chat-tools'] as const,
};

export function useAppsCatalogSources() {
    const n8n = useQuery<N8nWorkflow[], Error>({
        queryKey: appsCatalogKeys.n8n,
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            const data = await readJson(`${API_BASE}/ai/n8n/config`);
            return data?.workflows?.length
                ? data.workflows.filter((w) => w.enabled && !w.allowKbIngestion)
                : EMPTY_WORKFLOWS;
        },
    });
    const mcp = useQuery<McpServerSource[], Error>({
        queryKey: appsCatalogKeys.mcp,
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            const data = await readJson(`${API_BASE}/ai/mcp-servers/user-credentials`);
            return data?.servers?.length
                ? data.servers.filter((s) => (s.toolCount ?? 0) > 0)
                : EMPTY_SERVERS;
        },
    });
    const steps = useQuery<ExposedStepSource[], Error>({
        queryKey: appsCatalogKeys.steps,
        retry: false,
        staleTime: 0,
        queryFn: async () => {
            const data = await readJson(`${API_BASE}/api/step/chat-tools`);
            return Array.isArray(data?.tools) ? data.tools : EMPTY_STEPS;
        },
    });
    return {
        n8nWorkflows: n8n.data ?? EMPTY_WORKFLOWS,
        mcpServers: mcp.data ?? EMPTY_SERVERS,
        exposedSteps: steps.data ?? EMPTY_STEPS,
    };
}
