/**
 * The organisation's n8n connection, as server/routes/ai/config/integrations.js
 * serialises it (the /ai/n8n/* routes).
 */

export const N8N_INPUT_TYPES = ['string', 'number', 'file', 'json'] as const;
export type N8nInputType = (typeof N8N_INPUT_TYPES)[number];

/** One input the AI fills in when it runs the workflow. */
export interface N8nInput {
    name: string;
    type: N8nInputType;
    description: string;
    required: boolean;
}

/**
 * A configured workflow (the web's N8nSection `newWf`). The server stores the
 * list as given (`z.record(z.unknown())` per row), so `raw` keeps every field
 * this phone does not edit and a save sends it back untouched.
 */
export interface N8nWorkflow {
    id: string;
    name: string;
    /** The tool is `n8n_run_<slug>`. */
    slug: string;
    webhookPath: string;
    httpMethod: string;
    enabled: boolean;
    description: string;
    inputs: N8nInput[];
    allowKbIngestion: boolean;
    raw: Record<string, unknown>;
}

/** `GET /ai/n8n/config`. */
export interface N8nConfig {
    configured: boolean;
    n8nUrl: string;
    hasApiKey: boolean;
    workflows: N8nWorkflow[];
}

/** One active webhook workflow found on the n8n instance (`GET /ai/n8n/workflows`). */
export interface DiscoveredWorkflow {
    id: string;
    name: string;
    webhookNodes: { path: string; method: string }[];
}

/** `POST /ai/n8n/test`. */
export interface N8nTestResult {
    ok: boolean;
    activeWebhookCount: number | null;
    status: number | null;
    error: string | null;
}

/** `GET /ai/n8n/diagnostics`: the gates the AI's n8n tools pass or fail, for this person. */
export interface N8nDiagnostics {
    orgConfigured: boolean;
    orgEnabled: boolean;
    /** 'all_enabled' | 'org_override' | 'global_default'. */
    orgSource: string;
    userPasses: boolean;
    /** 'auto_enabled' | 'in_saved_list' | 'no_saved_list'. */
    userReason: string;
    canModify: boolean;
    tools: string[];
}

export interface N8nGroup {
    id: string;
    name: string;
    userCount: number;
    isGlobal: boolean;
}

/** `GET /ai/n8n/permissions`: who holds "Modify n8n Workflows", and who could. */
export interface N8nPermissions {
    holders: N8nGroup[];
    availableGroups: N8nGroup[];
    orgAdminAlways: boolean;
}

export const MODIFY_N8N = 'modify_n8n_workflows';
