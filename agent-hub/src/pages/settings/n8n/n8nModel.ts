/** Shapes of the /ai/n8n endpoints and the pure helpers over them. */

export const INPUT_TYPES = ['string', 'number', 'file', 'json'];

export interface N8nInput {
    name: string;
    type: string;
    description: string;
    required?: boolean;
}

/** A workflow configured as an AI tool (`n8n_run_<slug>`). */
export interface N8nWorkflow {
    id: string;
    name: string;
    slug: string;
    webhookPath?: string;
    httpMethod?: string;
    enabled: boolean;
    description?: string;
    inputs?: N8nInput[];
    outputs?: Array<{ name: string; type: string; description: string }>;
    allowKbIngestion?: boolean;
}

/** A webhook-triggered workflow found on the n8n instance. */
export interface DiscoveredWorkflow {
    id: string;
    name: string;
    webhookNodes?: Array<{ path?: string; method?: string }>;
}

export interface TestResult {
    ok: boolean;
    activeWebhookCount?: number | null;
    error?: string;
    status?: number;
}

export interface N8nDiagnostics {
    ok?: boolean;
    error?: string;
    org?: { n8nConfigured?: boolean; enabledIntegrationsIncludesN8n?: boolean; source?: string };
    userLevel?: { passes?: boolean; reason?: string };
    permissions?: { modify_n8n_workflows?: boolean };
    toolsThatWillBeInjected?: string[];
}

export interface N8nGroup {
    id: string;
    name: string;
    userCount?: number;
    isGlobal?: boolean;
}

export interface PermissionSummary {
    error?: string;
    editUrl?: string;
    modify_n8n_workflows?: N8nGroup[];
    availableGroups?: N8nGroup[];
    orgAdminAlways?: boolean;
}

export type FlashMessage = { type: 'success' | 'error'; text: string };

/** The tool slug a discovered workflow gets: lower-case words joined by `_`, at most 50 characters. */
function slugForWorkflow(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
}

/** A configured workflow for a discovered one, on its first webhook node. */
export function workflowFromDiscovered(discovered: DiscoveredWorkflow): N8nWorkflow {
    const wfNode = discovered.webhookNodes?.[0];
    return {
        id: discovered.id,
        name: discovered.name,
        slug: slugForWorkflow(discovered.name),
        webhookPath: wfNode?.path || '',
        httpMethod: wfNode?.method || 'POST',
        enabled: true,
        description: `Run n8n workflow: ${discovered.name}`,
        inputs: [],
        outputs: [{ name: 'result', type: 'string', description: 'Workflow output' }],
    };
}

/** Workflows whose name, slug or description contain the search text. */
export function filterConfigured(workflows: N8nWorkflow[], search: string): N8nWorkflow[] {
    if (!search.trim()) return workflows;
    const q = search.toLowerCase();
    return workflows.filter(w =>
        (w.name || '').toLowerCase().includes(q) ||
        (w.slug || '').toLowerCase().includes(q) ||
        (w.description || '').toLowerCase().includes(q),
    );
}

/** Discovered workflows whose name contains the search text. */
export function filterDiscovered(discovered: DiscoveredWorkflow[], search: string): DiscoveredWorkflow[] {
    if (!search.trim()) return discovered;
    const q = search.toLowerCase();
    return discovered.filter(w => (w.name || '').toLowerCase().includes(q));
}

/** `inputs` of workflow `wfId` passed through `change`. */
export function withInputs(workflows: N8nWorkflow[], wfId: string, change: (inputs: N8nInput[]) => N8nInput[]): N8nWorkflow[] {
    return workflows.map(w => (w.id !== wfId ? w : { ...w, inputs: change([...(w.inputs || [])]) }));
}
