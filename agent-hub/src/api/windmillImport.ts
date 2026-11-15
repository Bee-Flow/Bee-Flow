// Import from Windmill (server: routes/automation/windmillImport.mts,
// usecases/automation/windmillImport.mts): the ONLY place that knows these wire
// contracts. Every route needs the `automation_import` licence feature.
//
//   uploadWindmill(file, mode, select?)   a `wmill sync pull` zip, a flow JSON or flow.yaml
//   importRemoteWindmill(body)            a standalone Windmill read once with a read-only token
//   fetchImportReport(id)                 the stored report of one imported draft
//   acknowledgeImportItems(id, wmIds)     checklist items the person handles by hand
//   fetchWindmillInventory()              the Windmill flows that listen to this Nextcloud
//                                         (available: false when there is nothing to show,
//                                         unreachable: true when the connector did not answer)

import { apiJson } from './typedRequest';
import { errorBody, RefusedError } from './mutate';
import type { ApiBody } from './typedRequest';

export type ImportMode = 'preview' | 'commit';
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface WindmillWarning {
    code: string;
    message: string;
    wmId?: string;
}

interface WindmillModuleEntry {
    wmId: string;
    summary?: string;
    source: string;
    status: string;
    confidence: string;
    reason: string;
    stepIds: string[];
}

interface ChecklistItem {
    wmId: string;
    stepId: string | null;
    title: string;
    why: string;
    language?: string;
}

interface ConnectionHint {
    kind: 'resource' | 'variable';
    path: string;
    resourceType?: string;
    where: string[];
}

export interface WindmillFlowPreview {
    path: string;
    title: string;
    triggerType: string;
    generation: 'flow_exapp' | 'standalone' | null;
    counts: Record<string, number>;
    confidence: Confidence;
    modules: WindmillModuleEntry[];
    aiChecklist: ChecklistItem[];
    warnings: WindmillWarning[];
    connections: ConnectionHint[];
    outboundHosts: string[];
    suggestedRunPolicy: Record<string, unknown>;
    suggestedWebhookAuth?: string;
    validationErrors: string[];
    importable: boolean;
}

type ComparisonStatus = 'done' | 'no_runs' | 'skipped_flow_limit' | 'unauthorized' | 'unreadable' | 'budget_spent';

interface WindmillFlowResult {
    path: string;
    title: string;
    ok: boolean;
    automationId?: string;
    openItems?: number;
    error?: string;
    /** Only when the import compared this flow with its last Windmill runs: counts, never a value. */
    compared?: { status: ComparisonStatus; scenarios: number; reachedEnd: number };
}

export interface WindmillImportAnswer {
    mode: ImportMode;
    flows: WindmillFlowPreview[];
    notMigrated: string[];
    readWarnings: string[];
    notes: string[];
    /** Source W only, while the server has the comparison on: how many runs per flow it compares. */
    compare?: { runs: number };
    results?: WindmillFlowResult[];
}

/** One Windmill run replayed as a dry run of the draft: statuses, step ids, codes and key paths, never a value. */
export interface ComparisonScenario {
    windmillRunId: string;
    windmillSuccess: boolean | null;
    status: string;
    reachedEnd: boolean;
    failedSteps: Array<{ stepId: string; code: string }>;
    shapeDiffs: Array<{ stepId: string; wmId: string; simulated: boolean; missing: string[]; extra: string[] }>;
    saved: { golden: boolean; runId: string | null; reason: string | null } | null;
}

export interface ImportComparison {
    at: string;
    requested: number;
    status: ComparisonStatus;
    savedAsTests: boolean;
    scenarios: ComparisonScenario[];
}

export interface ImportReportView {
    automationId: string;
    sourceKind: 'windmill_upload' | 'windmill_api';
    windmillPath: string | null;
    windmillGeneration: string | null;
    createdAt: string | null;
    acknowledged: string[];
    dryRunOkAt: string | null;
    gate: { applies: boolean; open: Array<{ wmId: string; stepId: string | null; title: string }>; dryRunRequired: boolean; cleared: boolean };
    report: {
        title?: string;
        flowPath?: string;
        counts?: Record<string, number>;
        confidence?: Confidence;
        aiChecklist?: ChecklistItem[];
        warnings?: WindmillWarning[];
        connections?: ConnectionHint[];
        outboundHosts?: string[];
        appliedRunPolicy?: Record<string, unknown>;
        suggestedRunPolicy?: Record<string, unknown>;
        notes?: string[];
        /** The side-by-side comparison with the last Windmill runs, when the import made one. */
        comparison?: ImportComparison;
    };
    /** The "Complete with AI" briefing for the open items; null when nothing is open. */
    brief: string | null;
}

interface WindmillInventoryFlow {
    path: string;
    summary: string;
    events: string[];
    active: boolean;
}

export interface WindmillInventory {
    available: boolean;
    generation?: 'flow_exapp' | 'standalone';
    flows: WindmillInventoryFlow[];
    /** The Bee Flow app in Nextcloud did not answer (502 nextcloud_connector_unreachable): worth a retry. */
    unreachable?: boolean;
}

/** The type the upload guard checks the bytes against, from the file's extension. */
function uploadTypeFor(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower.endsWith('.zip')) return 'application/zip';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
    return null;
}

export function uploadWindmill(file: File, mode: ImportMode, select?: string[]): Promise<WindmillImportAnswer> {
    const form = new FormData();
    form.append('mode', mode);
    if (select) form.append('select', JSON.stringify(select));
    // The browser's own type for .yaml (or none) is not one the guard knows: name it by extension.
    const type = uploadTypeFor(file.name) ?? file.type;
    form.append('file', new File([file], file.name, { type }), file.name);
    return apiJson<'POST /api/automation/import/windmill/upload', WindmillImportAnswer>('POST /api/automation/import/windmill/upload', { init: { body: form } });
}

export type RemoteImportBody = ApiBody<'POST /api/automation/import/windmill/remote'>;

export function importRemoteWindmill(body: RemoteImportBody): Promise<WindmillImportAnswer> {
    return apiJson<'POST /api/automation/import/windmill/remote', WindmillImportAnswer>('POST /api/automation/import/windmill/remote', { body });
}

export function fetchImportReport(automationId: string): Promise<ImportReportView> {
    return apiJson<'GET /api/automation/{id}/import-report', ImportReportView>('GET /api/automation/{id}/import-report', { params: { id: automationId } });
}

export function acknowledgeImportItems(automationId: string, wmIds: string[]): Promise<ImportReportView> {
    return apiJson<'POST /api/automation/{id}/import-report/acknowledge', ImportReportView>('POST /api/automation/{id}/import-report/acknowledge', { params: { id: automationId }, body: { wmIds } });
}

const NO_INVENTORY: WindmillInventory = { available: false, flows: [] };
const UNREACHABLE: WindmillInventory = { available: false, flows: [], unreachable: true };

/**
 * The inventory panel's data (GET /api/automation/import/windmill/inventory).
 * `available: false` (no Nextcloud, no paired or too old a connector), a 404
 * (a server without the route) and a 403 (not an organisation admin, or no
 * licence) and any other refusal all mean "nothing to show", never an error
 * on screen. A connector that did not answer is the one case worth a retry.
 */
export async function fetchWindmillInventory(): Promise<WindmillInventory> {
    try {
        const body = await apiJson<'GET /api/automation/import/windmill/inventory', Partial<WindmillInventory> | null>('GET /api/automation/import/windmill/inventory');
        if (!body || body.available !== true || !Array.isArray(body.flows)) return NO_INVENTORY;
        return { available: true, ...(body.generation ? { generation: body.generation } : {}), flows: body.flows };
    } catch (e) {
        if (!(e instanceof RefusedError)) throw e;
        const code = (errorBody(e) as { code?: unknown } | null)?.code;
        if (e.status === 502 && code === 'nextcloud_connector_unreachable') return UNREACHABLE;
        // 404, 403 and any other refusal: the upload works without the panel.
        return NO_INVENTORY;
    }
}
