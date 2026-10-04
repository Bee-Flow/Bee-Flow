// Client for POST /api/studio-documents/:id/sheet/assistant. The server runs
// the model (5 to 60 s) and SAVES the cell changes before it answers.

import { API_BASE, authFetch } from '../../../utils/helpers';
import { SheetApiError } from './sheetApi';
import type { SelectionKind } from './sheetModel';
import type { SheetChartConfig } from './sheetCharts';

export interface AssistantTurn { role: 'user' | 'assistant'; content: string }

export interface AssistantRequest {
    message: string;
    /** A bounded A1 range inside A1:Z2000. */
    selection?: string | null;
    /** What the selection is: whole columns / rows are sent as bounded ranges. */
    selectionKind?: SelectionKind;
    /** The active sheet tab to work on. */
    tab?: string | null;
    history?: AssistantTurn[];
    modelTier?: string;
}

export interface AssistantChange { before: string; after: string }

export interface AssistantAnswer {
    reply: string;
    changes: Record<string, AssistantChange>;
    charts?: SheetChartConfig[];
    rounds: number;
    tier: string | null;
}

export async function askSheetAssistant(id: string, request: AssistantRequest, signal?: AbortSignal): Promise<AssistantAnswer> {
    const res = await authFetch(`${API_BASE}/api/studio-documents/${encodeURIComponent(id)}/sheet/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new SheetApiError((body && body.error) || 'The assistant could not answer.', res.status, body?.code);
    if (!body || typeof body.reply !== 'string') throw new SheetApiError('The assistant could not answer.', res.status, 'not_json');
    return {
        reply: body.reply,
        changes: body.changes && typeof body.changes === 'object' ? body.changes : {},
        charts: Array.isArray(body.charts) ? body.charts : undefined,
        rounds: Number(body.rounds) || 0,
        tier: typeof body.tier === 'string' ? body.tier : null,
    };
}
