/**
 * The example payloads of the table steps, as they look BEFORE any run.
 * Shared with the phone (mirrored into its bindings/mirror/ by
 * scripts/gen-shared-mirror.mjs), so both pickers offer the same fields.
 *
 * The table is a placeholder (`dry-run`, no run id), so nothing mistakes it for
 * a stored table; once the step has run, the real handle replaces it.
 */

function tableHandleSample(name: string) {
    return {
        kind: 'table', tableId: 'dry-run', runId: null, name, columns: [], rowCount: 0,
        preview: [], expiresAt: null, provenance: null,
    };
}

/**
 * What a Read table step hands downstream: the first sheet as `table`, every
 * sheet in `tables` and by name in `tablesByName`, plus facts about the file.
 */
export function readTableSample() {
    const handle = tableHandleSample('Sheet1');
    return {
        table: handle,
        tables: [handle],
        tablesByName: { Sheet1: handle },
        sheets: [{ name: 'Sheet1', index: 0, hidden: false, rowCount: 0, columnCount: 0, tableIndex: 0 }],
        provenance: null,
        source: { filename: 'file.xlsx', format: 'xlsx', size: 0 },
        warnings: [],
    };
}

/**
 * What an Edit table step hands downstream: the table itself, its size and
 * columns, and the rows and a text version of them when the table is small.
 */
export function editTableSample(name: string) {
    return {
        table: tableHandleSample(name),
        rowCount: 0,
        columns: [],
        rows: [],
        markdown: '',
        opStats: [],
        warnings: [],
    };
}

/**
 * What a Write table step hands downstream (execWriteTable.mts): the file it
 * wrote, with the same `fileId` a document step offers (a download field or an
 * attachment binds it alike), and `sourceHandle` for an upload or a later Read
 * table step.
 */
export function writeTableSample(format: unknown) {
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    return {
        fileId: 'f_1a2b3c',
        filename: `table.${ext}`,
        mimeType: ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 0,
        format: ext,
        rowCount: 0,
        columns: [],
        highlightedRows: 0,
        sourceHandle: { kind: 'generated_file', fileId: 'f_1a2b3c' },
        warnings: [],
    };
}
