/**
 * The draft and the patch of a Write table step, with the server's defaults
 * (core/automationModel/tableOps/writeTableSpec.mts). Mirrored to the phone
 * (mobile/src/features/flow-editor/bindings/mirror/formState/writeTable.ts, by
 * scripts/gen-shared-mirror.mjs), so both editors write the same step.
 */
import type { FormRecord } from './types';

export interface OutputColumn { column: string; header: string | null }

const clone = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const keepDays = (v: unknown): number => Math.min(90, Math.max(1, Math.round(Number(v)) || 7));

/** The columns as the editor edits them: `{ column, header }`; a bare name is a column. */
function outputColumns(v: unknown): OutputColumn[] {
    if (!Array.isArray(v)) return [];
    return v.map((c: unknown) => {
        if (typeof c === 'string') return { column: c, header: null };
        const r = (c && typeof c === 'object' ? c : {}) as { column?: unknown; header?: unknown };
        return { column: typeof r.column === 'string' ? r.column : '', header: typeof r.header === 'string' && r.header ? r.header : null };
    });
}

/** `base` is the step's label and icon (FormBase). */
export function extractWriteTable(step: FormRecord, base: FormRecord): FormRecord {
    return {
        ...base,
        source: clone(step.source ?? null),
        format: step.format === 'csv' ? 'csv' : 'xlsx',
        fileName: typeof step.fileName === 'string' ? step.fileName : '',
        sheetName: typeof step.sheetName === 'string' ? step.sheetName : '',
        columns: outputColumns(step.columns),
        highlightColumn: typeof step.highlightColumn === 'string' ? step.highlightColumn : '',
        delimiter: typeof step.delimiter === 'string' && step.delimiter ? step.delimiter : ';',
        expiresInDays: typeof step.expiresInDays === 'number' && Number.isFinite(step.expiresInDays) ? step.expiresInDays : 7,
    };
}

export function patchWriteTable(patch: FormRecord, _step: FormRecord, draft: FormRecord): void {
    patch.source = draft.source ?? undefined;
    patch.format = draft.format === 'csv' ? 'csv' : 'xlsx';
    patch.fileName = typeof draft.fileName === 'string' ? draft.fileName : '';
    patch.sheetName = text(draft.sheetName) || undefined;
    patch.columns = outputColumns(draft.columns)
        .map(c => ({ column: text(c.column), header: text(c.header) || null }))
        .filter(c => c.column);
    patch.highlightColumn = text(draft.highlightColumn) || undefined;
    patch.delimiter = patch.format === 'csv' && typeof draft.delimiter === 'string' && draft.delimiter ? draft.delimiter : undefined;
    patch.expiresInDays = keepDays(draft.expiresInDays);
}
