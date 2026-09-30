/** Contract readers for the /ai/n8n/* answers (model/n8nTypes.ts). */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import {
    N8N_INPUT_TYPES,
    type DiscoveredWorkflow,
    type N8nConfig,
    type N8nDiagnostics,
    type N8nGroup,
    type N8nPermissions,
    type N8nTestResult,
    type N8nWorkflow,
} from '../model/n8nTypes';

const readInputs = shapeListOf({
    name: field.str(''),
    type: field.oneOf(N8N_INPUT_TYPES, 'string'),
    description: field.str(''),
    required: field.bool(true),
});

const readWorkflowFields = shapeOf({
    id: field.str(''),
    name: field.str(''),
    slug: field.str(''),
    webhookPath: field.str(''),
    httpMethod: field.str('POST'),
    enabled: field.bool(true),
    description: field.str(''),
    inputs: readInputs,
    allowKbIngestion: field.bool(false),
});

function readWorkflow(raw: unknown): N8nWorkflow {
    return { ...readWorkflowFields(raw), raw: field.record<Record<string, unknown>>({})(raw) };
}

/** The stored list; a row without an id cannot be edited and is dropped. */
function readWorkflows(raw: unknown): N8nWorkflow[] {
    return Array.isArray(raw) ? raw.map(readWorkflow).filter((w) => w.id) : [];
}

export const readN8nConfig: (raw: unknown) => N8nConfig = shapeOf({
    configured: field.bool(false),
    n8nUrl: field.str(''),
    hasApiKey: field.bool(false),
    workflows: readWorkflows,
});

const readDiscoveredRows = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    webhookNodes: shapeListOf({ path: field.str(''), method: field.str('POST') }),
});

export function readDiscovered(raw: unknown): DiscoveredWorkflow[] {
    return readDiscoveredRows(pick(raw, 'workflows')).filter((w) => w.id);
}

export const readN8nTest: (raw: unknown) => N8nTestResult = shapeOf({
    ok: field.bool(false),
    activeWebhookCount: field.numOrNull,
    status: field.numOrNull,
    error: field.strOrNull,
});

export function readN8nDiagnostics(raw: unknown): N8nDiagnostics {
    const org = pick(raw, 'org');
    const user = pick(raw, 'userLevel');
    return {
        orgConfigured: field.bool(false)(pick(org, 'n8nConfigured')),
        orgEnabled: field.bool(false)(pick(org, 'enabledIntegrationsIncludesN8n')),
        orgSource: field.str('')(pick(org, 'source')),
        userPasses: field.bool(false)(pick(user, 'passes')),
        userReason: field.str('')(pick(user, 'reason')),
        canModify: field.bool(false)(pick(pick(raw, 'permissions'), 'modify_n8n_workflows')),
        tools: field.strArray(pick(raw, 'toolsThatWillBeInjected')),
    };
}

const readGroups = (raw: unknown): N8nGroup[] =>
    shapeListOf({ id: field.str(''), name: field.str(''), userCount: field.num(0), isGlobal: field.bool(false) })(raw).filter(
        (g) => g.id,
    );

export function readN8nPermissions(raw: unknown): N8nPermissions {
    return {
        holders: readGroups(pick(raw, 'modify_n8n_workflows')),
        availableGroups: readGroups(pick(raw, 'availableGroups')),
        orgAdminAlways: field.bool(true)(pick(raw, 'orgAdminAlways')),
    };
}
