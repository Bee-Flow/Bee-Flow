/**
 * write_table step: a table of this run becomes a file (.xlsx or .csv) of this
 * run. The counterpart of read_table.
 *
 * The source is a table handle (read_table / table, or `{ table }` around one)
 * or a list of rows (a Code step, a tool result, `{ rows }`). The step picks
 * and orders the columns, names their headers, and in an .xlsx file marks the
 * rows whose `highlightColumn` is not empty (a flags column: the rows to check)
 * with a fill. The file is kept like a generated document (execDocument.js
 * keepGeneratedFile: one size cap, one key scheme, one TTL clamp), so later
 * steps pass `output.sourceHandle` on the way they pass any generated file: a
 * mail attachment, a Nextcloud or Drive upload, a form page download.
 *
 * Output: { fileId, filename, mimeType, size, format, rowCount, columns
 *   [{ key, header }], highlightedRows, sourceHandle, warnings }
 *
 * A dry run stores nothing and returns the same shape. Text cells are written
 * as text: an .xlsx inline string is never a formula, and the CSV writer puts a
 * quote before a formula-shaped cell.
 */

import { createRequire } from 'node:module';
import { normalizeWriteTableStep, validateWriteTableStep, type WriteTableSpec } from '../automationModel/tableOps/writeTableSpec.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Column = { key: string; label?: string };
type Handle = { tableId?: string; columns?: Column[]; name?: string };
type Opened = { columns: Column[]; rows: () => AsyncIterable<Row> | Iterable<Row> };
type Limits = { maxRows: number; writeMaxRows: number };

/** Rows of one .xlsx sheet below the header (Excel's hard limit is 1,048,576 rows). */
export const XLSX_MAX_DATA_ROWS = 1_048_575;

export interface WriteTableCtx {
    userId: string;
    automationId: string;
    runId: string;
    rootRunId?: string;
    [key: string]: unknown;
}

const lazy = <T,>(path: string) => () => nodeRequire(path) as T;
const tables = {
    handle: lazy<typeof import('./tables/handle.js')>('./tables/handle'),
    store: lazy<typeof import('./tables/tableStore.js')>('./tables/tableStore'),
    list: lazy<typeof import('./tables/listSource.js')>('./tables/listSource'),
    limits: lazy<typeof import('./tables/limits.js')>('./tables/limits'),
};

// The collaborators, required lazily so a test can hand in fakes.
export const defaultDeps = {
    resolveValue: (binding: unknown, runState: unknown): unknown => nodeRequire('../automationModel/bind').resolveValue(binding, runState),
    interpolateTemplate: (template: string, runState: unknown): string => nodeRequire('../automationModel/bind').interpolateTemplate(template, runState),
    isTableHandle: (v: unknown): boolean => tables.handle().isTableHandle(v),
    openTable: (h: Handle, scope: Record<string, unknown>): Promise<Opened | null> => tables.store().openTable(h as never, scope as never) as Promise<Opened | null>,
    listToTable: (v: unknown, o: { maxRows: number }) => tables.list().listToTable(v, o),
    tableLimits: (): Limits => tables.limits().tableLimits(),
    buildXlsx: (sheets: unknown[]): Promise<Buffer> => nodeRequire('../documents/office/xlsxWorkbook').buildXlsxWorkbook(sheets),
    buildCsv: (a: { matrix: unknown[][]; delimiter: string }): { buffer: Buffer } => nodeRequire('../documents/office/officegen').buildCsv(a),
    storageAvailable: (): boolean => {
        const storage = nodeRequire('../../stores/storageStore');
        return typeof storage.isAvailable !== 'function' || storage.isAvailable();
    },
    keepGeneratedFile: (a: Record<string, unknown>): Promise<{ id: string }> => nodeRequire('./execDocument').keepGeneratedFile(a),
    safeDocumentName: (raw: string, fallback: string): string => nodeRequire('./execDocument').safeDocumentName(raw, fallback),
    noteRunWarning: (runState: unknown, line: string): void => nodeRequire('./runWarnings').noteRunWarning(runState, line),
};
export type WriteTableDeps = typeof defaultDeps;

const MIME: Record<WriteTableSpec['format'], string> = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv; charset=utf-8',
};

function stepError(errorClass: string, message: string, field?: string): Error {
    return Object.assign(new Error(message), { errorClass, ...(field ? { field } : {}) });
}

const fold = (v: unknown) => String(v ?? '').normalize('NFKC').trim().toLowerCase();
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** The column a name points at: its key or label, exactly, then ignoring case. */
function findColumn(columns: Column[], name: string): Column | null {
    return columns.find((c) => c.key === name || c.label === name)
        ?? columns.find((c) => fold(c.key) === fold(name) || fold(c.label) === fold(name))
        ?? null;
}

/** The handle a bound value is, or that it carries as `.table`. */
function handleOf(value: unknown, deps: WriteTableDeps): Handle | null {
    if (deps.isTableHandle(value)) return value as Handle;
    const inner = value && typeof value === 'object' ? (value as { table?: unknown }).table : undefined;
    return deps.isTableHandle(inner) ? inner as Handle : null;
}

interface Plan { columns: Array<{ key: string; header: string }>; highlight: string | null }

/** The output columns (all, or the chosen ones in their order) and the key of the highlight column. */
function planOutput(spec: WriteTableSpec, columns: Column[]): Plan {
    const chosen = spec.columns.length
        ? spec.columns.map((c) => {
            const col = findColumn(columns, c.column);
            if (!col) throw stepError('write_table_column_missing', `The table has no column "${c.column}". Pick one of: ${columns.map((x) => x.label || x.key).slice(0, 30).join(', ')}.`, 'columns');
            return { key: col.key, header: c.header || col.label || col.key };
        })
        : columns.map((c) => ({ key: c.key, header: c.label || c.key }));
    let highlight: string | null = null;
    if (spec.highlightColumn) {
        const col = findColumn(columns, spec.highlightColumn);
        if (!col) throw stepError('write_table_column_missing', `The table has no column "${spec.highlightColumn}" to mark rows by.`, 'highlightColumn');
        highlight = col.key;
    }
    return { columns: chosen, highlight };
}

/** The source as columns and rows: an opened stored table, or a list made into one. */
async function openSource(spec: WriteTableSpec, ctx: WriteTableCtx, runState: unknown, deps: WriteTableDeps, limits: Limits): Promise<Opened> {
    const value = deps.resolveValue(spec.source, runState);
    const handle = handleOf(value, deps);
    if (handle) {
        const scope = { runId: ctx.runId, rootRunId: ctx.rootRunId, automationId: ctx.automationId, userId: ctx.userId };
        const opened = await deps.openTable(handle, scope);
        if (!opened) throw stepError('table_not_found', 'The table from an earlier step has expired or belongs to another run. Run the step that makes it again.', 'source');
        return opened;
    }
    const listed = deps.listToTable(value, { maxRows: limits.maxRows });
    if (!listed) {
        throw stepError('table_source_unresolved', 'This step writes a table, but its source did not resolve to a table or a list of rows. Bind it to steps.<id>.output.table of a read_table or table step.', 'source');
    }
    return { columns: listed.columns, rows: () => listed.rows };
}

/** The cell matrix (header first) and the matrix indices of the highlighted rows. */
async function collect(opened: Opened, plan: Plan, cap: number): Promise<{ matrix: unknown[][]; highlighted: number[] }> {
    const matrix: unknown[][] = [plan.columns.map((c) => c.header)];
    const highlighted: number[] = [];
    for await (const row of opened.rows()) {
        if (cap > 0 && matrix.length > cap) {
            throw stepError('table_too_large', `The table has more than ${cap} rows, more than one file of this step may hold (AUTOMATION_TABLE_WRITE_MAX_ROWS). Filter or split it first.`, 'source');
        }
        if (plan.highlight && !isBlank(row[plan.highlight])) highlighted.push(matrix.length);
        matrix.push(plan.columns.map((c) => (row[c.key] === undefined ? null : row[c.key])));
    }
    return { matrix, highlighted };
}

function fileNameOf(spec: WriteTableSpec, step: { label?: string }, runState: unknown, deps: WriteTableDeps): string {
    const raw = deps.interpolateTemplate(spec.fileName || '', runState).trim().replace(/\.(xlsx|csv)$/i, '');
    return `${deps.safeDocumentName(raw || step.label || 'table', 'table')}.${spec.format}`;
}

function dryRunOutput(spec: WriteTableSpec, filename: string) {
    return {
        output: {
            fileId: 'dry-run', filename, mimeType: MIME[spec.format], size: 0, format: spec.format, rowCount: 0,
            columns: spec.columns.map((c) => ({ key: c.column, header: c.header || c.column })), highlightedRows: 0,
            sourceHandle: { kind: 'generated_file', fileId: 'dry-run' }, warnings: [] as string[], _dryRun: true,
        },
        dryRunSynthesised: true,
    };
}

export async function execWriteTable(step: { id: string; label?: string; [key: string]: unknown }, ctx: WriteTableCtx, runState: unknown, mode: string, overrides: Partial<WriteTableDeps> = {}) {
    const deps = { ...defaultDeps, ...overrides };
    const missing = validateWriteTableStep(step).find((f) => f.code === 'write_table.source_missing');
    if (missing) throw stepError('table_source_missing', `write_table "${step.label || step.id}": ${missing.message} ${missing.hint || ''}`.trim(), 'source');
    const spec = normalizeWriteTableStep(step);
    const filename = fileNameOf(spec, step, runState, deps);
    if (mode === 'dry_run') return dryRunOutput(spec, filename);
    if (!deps.storageAvailable()) throw stepError('storage_unavailable', 'write_table: file storage is not available, so the file cannot be kept.');

    const limits = deps.tableLimits();
    const opened = await openSource(spec, ctx, runState, deps, limits);
    const plan = planOutput(spec, opened.columns);
    const cap = spec.format === 'xlsx' ? Math.min(limits.writeMaxRows > 0 ? limits.writeMaxRows : Infinity, XLSX_MAX_DATA_ROWS) : limits.writeMaxRows;
    const { matrix, highlighted } = await collect(opened, plan, cap);
    const warnings: string[] = [];
    if (plan.highlight && spec.format === 'csv') warnings.push('A CSV file has no colours, so the rows to mark are not marked; write xlsx to mark them.');
    const buffer = spec.format === 'xlsx'
        ? await deps.buildXlsx([{ name: spec.sheetName || step.label || 'Sheet1', matrix, style: { header: true, highlightRows: highlighted } }])
        : deps.buildCsv({ matrix, delimiter: spec.delimiter }).buffer;
    const row = await deps.keepGeneratedFile({ ctx, step, buffer, contentType: MIME[spec.format], filename, ttlDays: spec.expiresInDays, stepLabel: 'write_table' });
    for (const w of warnings) deps.noteRunWarning(runState, `${step.id}: ${w}`);
    return {
        output: {
            fileId: row.id, filename, mimeType: MIME[spec.format], size: buffer.length, format: spec.format,
            rowCount: matrix.length - 1, columns: plan.columns, highlightedRows: highlighted.length,
            // The handle nextcloud_upload_file, drive_upload_file, a mail attachment
            // and twoba_upload_conditions take (sourceHandle: steps.<id>.output.sourceHandle).
            sourceHandle: { kind: 'generated_file', fileId: row.id },
            warnings,
        },
    };
}
