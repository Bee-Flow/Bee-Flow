// @typecheck
/**
 * read_table step: open an uploaded or generated spreadsheet / CSV as tables,
 * one per sheet, kept in the run's table store.
 *
 * The step output carries HANDLES (name, columns, row count, a short preview),
 * never the rows: later steps pass `output.table` on, and the run page pages
 * through it. Output:
 *
 *   { tables, table (the first, or null), tablesByName, sheets, provenance,
 *     source: { filename, format, size }, warnings }
 *
 * The executor only resolves the source, calls the reader and writes the
 * tables. The file itself is untrusted: reading it (size, zip guard, parse,
 * caps) is tables/workbook.js, and fetching its bytes (and checking that the
 * file belongs to this automation) is tables/sourceFile.js. A dry run never
 * touches storage.
 */

'use strict';

const { resolveValue } = require('../automationModel/bind');
const { normalizeReadTableStep, validateReadTableStep } = require('../automationModel/tableOps/readTableSpec');
const { noteRunWarning } = require('./runWarnings');

// The collaborators, required lazily so this file loads before they do and a
// test can hand in fakes.
const defaultDeps = {
    readSourceFile: (/** @type {any[]} */ ...a) => /** @type {any} */ (require('./tables/sourceFile')).readSourceFile(...a),
    writeTable: (/** @type {any[]} */ ...a) => /** @type {any} */ (require('./tables/tableStore')).writeTable(...a),
    readWorkbookTables: (/** @type {any[]} */ ...a) => /** @type {any} */ (require('./tables/workbook')).readWorkbookTables(...a),
    dryRunHandle: (/** @type {any[]} */ ...a) => /** @type {any} */ (require('./tables/handle')).dryRunHandle(...a),
    tableLimits: () => require('./tables/limits').tableLimits(),
};

const isBlank = (v) => v === undefined || v === null || v === '';

function sourceMissing(step) {
    return Object.assign(
        new Error(`read_table "${step.label || step.id}": no file is bound. Bind the source to a form file answer (trigger.output.<field>) or to a generated file.`),
        { errorClass: 'table_source_missing' },
    );
}

/** The output of a dry run: the live shape with nothing in it. */
function dryRunOutput(deps) {
    return {
        output: {
            tables: [],
            table: deps.dryRunHandle({ name: 'Sheet1', columns: [] }),
            tablesByName: {},
            sheets: [],
            provenance: null,
            source: null,
            warnings: [],
            _dryRun: true,
        },
        dryRunSynthesised: true,
    };
}

/** One entry of output.sheets for a sheet the reader returned. */
function sheetSummary(sheet, tableIndex) {
    return {
        name: sheet.name,
        index: sheet.index,
        hidden: sheet.hidden,
        rowCount: tableIndex === null ? 0 : sheet.rows.length,
        columnCount: tableIndex === null ? 0 : sheet.columns.length,
        tableIndex,
        ...(sheet.skipped ? { skipped: sheet.skipped } : {}),
    };
}

/**
 * @param {any} step
 * @param {any} ctx
 * @param {any} runState
 * @param {'live'|'dry_run'|string} mode
 * @param {typeof defaultDeps} [deps]
 */
async function execReadTable(step, ctx, runState, mode, deps = defaultDeps) {
    // A step with no source at all is a configuration error in either mode.
    if (validateReadTableStep(step).some(f => f.code === 'read_table.source_missing')) throw sourceMissing(step);
    const spec = normalizeReadTableStep(step);
    // A dry run proves the wiring; the upload it would read does not exist yet.
    if (mode === 'dry_run') return dryRunOutput(deps);

    const value = resolveValue(spec.source, runState);
    if (isBlank(value)) throw sourceMissing(step);

    const file = await deps.readSourceFile(value, ctx);
    const limits = deps.tableLimits();
    const read = await deps.readWorkbookTables(file.buffer, {
        filename: file.filename,
        format: spec.format,
        sheets: spec.sheets,
        headerRow: spec.headerRow,
        delimiter: spec.delimiter,
        provenanceSheet: spec.provenanceSheet,
        skipHiddenSheets: spec.skipHiddenSheets,
        limits,
    });

    const tables = [];
    const named = [];
    const sheets = [];
    for (const sheet of read.sheets) {
        if (sheet.skipped) { sheets.push(sheetSummary(sheet, null)); continue; }
        const handle = await deps.writeTable({
            ctx, stepId: step.id, name: sheet.name, columns: sheet.columns, rows: sheet.rows,
            ttlDays: spec.expiresInDays, provenance: read.provenance,
        });
        sheets.push(sheetSummary(sheet, tables.length));
        tables.push(handle);
        named.push([sheet.name, handle]);
        sheet.rows = [];                       // written: let the rows go before the next sheet is stored
    }
    const warnings = [...read.warnings];
    if (!tables.length) warnings.push('No sheet in this file had a header or data, so no table was made.');
    for (const w of warnings) noteRunWarning(runState, `${step.id}: ${w}`);

    return {
        output: {
            tables,
            table: tables[0] || null,
            tablesByName: Object.fromEntries(named),
            sheets,
            provenance: read.provenance || null,
            source: { filename: file.filename, format: read.format, size: file.size },
            warnings,
        },
    };
}

module.exports = { execReadTable, defaultDeps };
