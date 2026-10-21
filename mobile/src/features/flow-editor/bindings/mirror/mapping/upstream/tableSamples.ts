// GENERATED from agent-hub/src/components/automation/Builder/mapping/upstream/tableSamples.ts by scripts/gen-shared-mirror.mjs — do not edit
/**
 * The example payloads of the two table steps, as they look BEFORE any run.
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
