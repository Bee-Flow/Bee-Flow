// @typecheck
/**
 * Spreadsheet Tools — the chat's way to hand the user a real .xlsx.
 *
 * One tool, `create_spreadsheet`, the sibling of create_word_document (.docx)
 * and create_presentation (.pptx): a first-party artefact tool, injected for
 * every signed-in user by core/integrations/integrationTools.js and dispatched
 * by core/tools/toolDispatcher.js. Not a catalog integration, and it does not
 * need Nextcloud (nextcloud_create_spreadsheet does).
 *
 * CONTENT. `sheets` is a list of tabs, each { name?, rows, columns? }, where
 * `rows` are row objects or arrays of cells, exactly as
 * nextcloud_create_spreadsheet takes them (rowsToMatrix in
 * core/documents/office/officegen.js). Numbers stay numbers; a formula is a
 * cell object { formula: "=SUM(B2:B10)" }, and text is always written as text.
 *
 * EDITING AN UPLOADED WORKBOOK. The model cannot patch a file; it reads the
 * attachment's content from the conversation and rebuilds the whole workbook
 * with the changes, which this tool then hands back as a new download.
 *
 * WHERE THE FILE GOES. This module only builds the .xlsx; a download link,
 * OneDrive (`oneDrivePath`) or Nextcloud (`nextcloudPath`) is
 * integrations/officeFileDelivery.js, shared with create_word_document.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_SHEETS = 20;
const MAX_CELLS = 50000;

const SPREADSHEET_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_spreadsheet',
            description: 'Build a REAL Excel workbook (.xlsx) that opens in Excel, LibreOffice and Nextcloud Office. Use it whenever the user asks for an Excel file, an .xlsx, a spreadsheet to download, or wants an UPLOADED spreadsheet changed and given back (the attachment\'s content is in the conversation: apply the changes and rebuild the WHOLE workbook, every sheet and row, with this tool). Never tell the user you cannot make or edit Excel files. `sheets` is a list of tabs; each has `rows` (objects keyed by column, or arrays of cells; numbers stay numbers; a FORMULA is a cell object {"formula": "=SUM(B2:B10)"}, while plain text, even one starting with "=", is written as text) and optional `columns` (header names) and `name`. WHERE IT GOES: by default the result has { downloadUrl, filename } — END YOUR REPLY with a markdown link [filename](downloadUrl). `nextcloudPath` saves it into Nextcloud (the result has `webUrl`: "Open in Nextcloud Office"), `oneDrivePath` into the user\'s own OneDrive (`webUrl`: "Open in OneDrive"); parent folders are created, never create them yourself. If the user did not say where they want it and Nextcloud or OneDrive tools are available to you, ASK first: a download, OneDrive or Nextcloud.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'The workbook title, used for the file name.' },
                    sheets: {
                        type: 'array',
                        description: `The tabs of the workbook (1 to ${MAX_SHEETS}).`,
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Tab name (max 31 characters). Defaults to "Sheet1", "Sheet2", ...' },
                                rows: {
                                    type: 'array',
                                    description: 'The rows: objects (column name -> value) or arrays of cell values. With arrays, put the header row first or give `columns`.',
                                    items: { anyOf: [{ type: 'object' }, { type: 'array', items: {} }] },
                                },
                                columns: { type: 'array', items: { type: 'string' }, description: 'Header names / column order. Optional.' },
                            },
                            required: ['rows'],
                        },
                    },
                    fileName: { type: 'string', description: 'Optional file name, e.g. "budget-2026.xlsx". Derived from the title when omitted.' },
                    nextcloudPath: { type: 'string', description: 'Save into the user\'s Nextcloud at this path — a folder ("/Documents") or a file path ("/Documents/budget.xlsx"). Only when the user asked for Nextcloud.' },
                    oneDrivePath: { type: 'string', description: 'Save into the user\'s own OneDrive at this path — a folder ("/Documents") or a file path. Only when the user asked for OneDrive.' },
                },
                required: ['title', 'sheets'],
            },
        },
    },
];

const SPREADSHEET_TOOL_NAMES = new Set(SPREADSHEET_TOOLS.map((t) => t.function.name));

function isSpreadsheetTool(toolName) {
    return SPREADSHEET_TOOL_NAMES.has(toolName);
}

/**
 * A file name that is safe on disk, in a storage key and in a
 * Content-Disposition header. ASCII only, like safeWordFileName.
 */
function safeSpreadsheetFileName(raw, fallback = 'spreadsheet') {
    const base = String(raw || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.xlsx$/i, '')
        .replace(/[^A-Za-z0-9._ -]+/g, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/ /g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '')
        .slice(0, 80);
    return `${base || fallback}.xlsx`;
}

/**
 * Build the .xlsx. Returns { buffer, contentType, filename, title, sheets, cells }
 * or { error } for anything the model can fix.
 */
async function buildSpreadsheetFile(args = {}) {
    const { rowsToMatrix } = require('../core/documents/office/officegen');
    const { buildXlsxWorkbook } = require('../core/documents/office/xlsxWorkbook');
    const raw = args.sheets;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: 'Give `sheets`: a list of tabs, each { name, rows, columns? } with at least one row.' };
    }
    if (raw.length > MAX_SHEETS) {
        return { error: `Too many sheets (${raw.length}); the maximum is ${MAX_SHEETS}. Merge or drop tabs.` };
    }
    const sheets = [];
    let cells = 0;
    for (let i = 0; i < raw.length; i++) {
        const sh = raw[i];
        if (!sh || typeof sh !== 'object' || !Array.isArray(sh.rows) || sh.rows.length === 0) {
            return { error: `Sheet ${i + 1} has no \`rows\`. Every sheet needs a non-empty list of rows (objects or arrays of cells).` };
        }
        if (!sh.rows.every((r) => r && typeof r === 'object')) {
            return { error: `Sheet ${i + 1}: every row must be an object or an array of cell values.` };
        }
        const matrix = rowsToMatrix(sh.rows, sh.columns, { keepFormulas: true });
        cells += matrix.reduce((n, r) => n + r.length, 0);
        if (cells > MAX_CELLS) {
            return { error: `The workbook is too large (more than ${MAX_CELLS} cells). Reduce the rows or columns.` };
        }
        sheets.push({ name: typeof sh.name === 'string' ? sh.name : `Sheet${i + 1}`, matrix });
    }
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
    const buffer = await buildXlsxWorkbook(sheets, { formulas: true });
    return {
        buffer,
        contentType: XLSX_MIME,
        filename: safeSpreadsheetFileName(args.fileName || title),
        title,
        note: sheets.length > 1 ? ` with ${sheets.length} sheets` : '',
        extra: { sheets: sheets.length },
    };
}

module.exports = {
    SPREADSHEET_TOOLS,
    isSpreadsheetTool,
    safeSpreadsheetFileName,
    buildSpreadsheetFile,
};
