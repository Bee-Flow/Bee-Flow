// The live preview of an "Edit table" step (server/routes/automation/tablePreview.js):
// the first rows of the result, what each operation did, and the findings that
// point at the field to fix. The answer stays in the editor: nothing here
// stores, logs or forwards the rows.

import { API_BASE, authFetch } from '../../../utils/helpers';
import { failure } from './http';
import type { TableColumn } from './runTables';

/** A table made by an earlier run of this automation, or a handful of rows sent along. */
export type PreviewSource =
    | { runId: string; tableId: string }
    | { rows: Record<string, unknown>[]; columns?: TableColumn[] };

export interface TablePreviewRequest {
    source: PreviewSource;
    ops: unknown[];
    /** Stop after this operation (its `id`). */
    upToOpId?: string;
    /** The second table of a join, by the id of the operation that asks for it. */
    joinSources?: Record<string, PreviewSource>;
    /** 1..50, default 20. */
    limit?: number;
}

interface OpIssue {
    code: string;
    field: string | null;
    message: string;
    hint?: string;
}

/** What one operation did to the sample. */
export interface OpResult {
    opId: string;
    op: string;
    enabled: boolean;
    ok: boolean;
    inputRows: number;
    outputRows: number;
    /** The column keys after this operation. */
    columns: string[];
    warnings: string[];
    error?: OpIssue;
}

export interface Finding {
    code: string;
    severity: 'error' | 'warning';
    /** Relative to the step: `ops[2].by[0]`. */
    path: string;
    message: string;
    hint?: string;
}

export type ColumnKind = 'single' | 'multi' | 'scale' | 'numeric' | 'date' | 'free_text' | 'identifier' | 'empty';

export interface DescribedColumn {
    key: string;
    label: string;
    kind: ColumnKind;
    storageType: string;
    filled: number;
    empty: number;
    distinct: number;
    options?: { value: string; count: number }[];
    usableAsSplit: boolean;
    looksPersonal: boolean;
    sampleValues: string[];
}

interface Description {
    rowCount: number;
    provenance: Record<string, string> | null;
    columns: DescribedColumn[];
}

interface Segment {
    id: string;
    label: string;
    column: string | null;
    value: string | null;
    n: number;
    rules: unknown[];
}

export interface TablePreviewOk {
    ok: true;
    columns: TableColumn[];
    rows: Record<string, unknown>[];
    rowCount: number;
    inputRows: number;
    inputCapped: boolean;
    description: Description | null;
    segments: Segment[] | null;
    opResults: OpResult[];
    warnings: string[];
}

interface TablePreviewFailed {
    ok: false;
    findings: Finding[];
    opResults: OpResult[];
}

export type TablePreviewResponse = TablePreviewOk | TablePreviewFailed;

export type PreviewFn = (automationId: string, body: TablePreviewRequest, signal?: AbortSignal) => Promise<TablePreviewResponse>;

/** POST /api/automation/:id/table-preview. A refusal (no access, rate limit) throws; an invalid config answers `ok: false`. */
export async function previewTable(automationId: string, body: TablePreviewRequest, signal?: AbortSignal): Promise<TablePreviewResponse> {
    const res = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(automationId)}/table-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw await failure(res, `Table preview ${res.status}`);
    return (await res.json()) as TablePreviewResponse;
}
