// Import from Windmill (server: routes/automation/windmillImport.mts,
// usecases/automation/windmillImport.mts): the ONLY place that knows these wire
// contracts. Every route needs the `automation_import` licence feature.
//
//   uploadWindmill(file, mode, select?)   a `wmill sync pull` zip, a flow JSON or flow.yaml
//   importRemoteWindmill(body)            a standalone Windmill read once with a read-only token
//   fetchImportReport(id)                 the stored report of one imported draft
//   acknowledgeImportItems(id, wmIds)     checklist items the person handles by hand
//   fetchWindmillInventory()              the Windmill flows that listen to this Nextcloud
//                                         (null when the server has no such route or nothing to show)

import { apiJson } from './typedRequest';
import { API_BASE, mutate, RefusedError } from './mutate';
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

interface WindmillFlowResult {
    path: string;
    title: string;
    ok: boolean;
    automationId?: string;
    openItems?: number;
    error?: string;
}

export interface WindmillImportAnswer {
    mode: ImportMode;
    flows: WindmillFlowPreview[];
    notMigrated: string[];
    readWarnings: string[];
    notes: string[];
    results?: WindmillFlowResult[];
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

/**
 * The inventory panel's data. The route is optional on a server (it comes with
 * the Nextcloud connector work): a 404, a 403 or any refusal means "nothing to
 * show", never an error on screen.
 */
export async function fetchWindmillInventory(): Promise<WindmillInventory> {
    try {
        const res = await mutate(`${API_BASE}/api/automation/import/windmill/inventory`);
        const body = (await res.json()) as Partial<WindmillInventory> | null;
        if (!body || body.available !== true || !Array.isArray(body.flows)) return NO_INVENTORY;
        return { available: true, ...(body.generation ? { generation: body.generation } : {}), flows: body.flows };
    } catch (e) {
        if (e instanceof RefusedError) return NO_INVENTORY;
        throw e;
    }
}
