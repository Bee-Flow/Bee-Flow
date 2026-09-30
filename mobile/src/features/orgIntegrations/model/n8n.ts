/**
 * The n8n settings' pure rules, lifted out of the web's N8nSection.jsx
 * (pinned by n8n.lockstep.test.ts): the tool slug, a discovered workflow
 * turned into a configured one, the search, the status line and the access
 * check's rows.
 */

import type { DiscoveredWorkflow, N8nDiagnostics, N8nTestResult, N8nWorkflow } from './n8nTypes';

/** addWorkflow's slug: lower-case, runs of other characters to `_`, trimmed, at most 50. */
export function workflowSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 50);
}

/** The slug field's own filter: what a person may type into it. */
export function cleanSlug(input: string): string {
    return input.replace(/[^a-z0-9_]/g, '');
}

/** Stored with the workflow as the tool's schema (read by the AI, not shown): the web's own English. */
const OUTPUT_DESCRIPTION = 'Workflow output';
const RESULT_OUTPUT = { name: 'result', type: 'string', description: OUTPUT_DESCRIPTION };

/** addWorkflow: a discovered webhook workflow, configured with the web's defaults. */
export function workflowFrom(found: DiscoveredWorkflow): N8nWorkflow {
    const node = found.webhookNodes[0];
    const outputs = [RESULT_OUTPUT];
    const workflow = {
        id: found.id,
        name: found.name,
        slug: workflowSlug(found.name),
        webhookPath: node?.path ?? '',
        httpMethod: node?.method ?? 'POST',
        enabled: true,
        description: `Run n8n workflow: ${found.name}`,
        inputs: [],
        allowKbIngestion: false,
    };
    return { ...workflow, raw: { ...workflow, outputs } };
}

/** What the PUT stores: the untouched fields, then the edited ones. */
export function serializeWorkflow(workflow: N8nWorkflow): Record<string, unknown> {
    const { raw, ...edited } = workflow;
    return { ...raw, ...edited };
}

function contains(value: string, needle: string): boolean {
    return value.toLowerCase().includes(needle);
}

/** filteredWorkflows: name, slug or description. */
export function matchWorkflows(list: readonly N8nWorkflow[], query: string): N8nWorkflow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...list];
    return list.filter((w) => contains(w.name, q) || contains(w.slug, q) || contains(w.description, q));
}

/** filteredDiscovered: by name only. */
export function matchDiscovered(list: readonly DiscoveredWorkflow[], query: string): DiscoveredWorkflow[] {
    const q = query.trim().toLowerCase();
    return q ? list.filter((w) => contains(w.name, q)) : [...list];
}

export type N8nStatus =
    | { kind: 'connected'; count: number | null }
    | { kind: 'failed'; error: string | null }
    | { kind: 'configured' }
    | { kind: 'unconfigured' };

/** StatusPill: the last test wins, else whether credentials are stored. */
export function n8nStatus(configured: boolean, test: N8nTestResult | null): N8nStatus {
    if (test?.ok) return { kind: 'connected', count: test.activeWebhookCount };
    if (test) return { kind: 'failed', error: test.error ? test.error.slice(0, 80) : null };
    return configured ? { kind: 'configured' } : { kind: 'unconfigured' };
}

export type AccessCheckId = 'credentials' | 'org_enabled' | 'user_can_use' | 'can_modify';

export interface AccessCheck {
    id: AccessCheckId;
    ok: boolean;
    /** Why, from the server's `source` / `reason`; null when it said nothing more. */
    detail: string | null;
    /** The fix the web offers on a failing row. */
    fix: 'enable_for_org' | 'permissions' | null;
}

/** AccessCheckCard's four rows, in its order. */
export function accessChecks(diag: N8nDiagnostics): AccessCheck[] {
    return [
        { id: 'credentials', ok: diag.orgConfigured, detail: null, fix: null },
        { id: 'org_enabled', ok: diag.orgEnabled, detail: diag.orgSource, fix: diag.orgEnabled ? null : 'enable_for_org' },
        { id: 'user_can_use', ok: diag.userPasses, detail: diag.userReason, fix: null },
        { id: 'can_modify', ok: diag.canModify, detail: diag.canModify ? 'granted' : 'ask_admin', fix: diag.canModify ? null : 'permissions' },
    ];
}
