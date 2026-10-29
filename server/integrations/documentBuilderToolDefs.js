// @typecheck strict
/**
 * Document builder tools — the function-calling definitions of the document
 * tools (executeDocumentTool, documentBuilderTools.js, runs them).
 */

'use strict';

const documentStore = require('../stores/documentStore');

/** @typedef {{ type: string, function: { name: string, description: string, parameters: { type: string, properties: Record<string, object>, required?: string[] } } }} ToolDef */

/** @type {ToolDef[]} */
const DOCUMENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_document',
            description: 'Create a new rendered Document (an invoice, quote, letter, report or similar) owned by the current user. Returns { documentId, url, name, message }.\n\nCall this FIRST when the user asks for a NEW document; do not call it to edit an existing one. A document has exactly TWO slots — `bodyHtml` (the body markup) and `css` (the stylesheet) — which you fill with document_write immediately afterwards.\n\nUse a Document, not a Webpage, whenever the thing is meant to be PRINTED or sent as a PDF: invoices, quotes, order confirmations, letters, certificates, reports. Use a Webpage when it is meant to be interactive or visited in a browser. When the user asks for a WORD file (.docx) to edit in Word, use create_word_document instead.\n\nA PRESENTATION in the library is `docType: "presentation"`: its body slot is a slide OUTLINE (markdown: "# " title, "## " per slide, "- " bullets, "### " cards, ```chart / ```stats blocks) and it has no css — the house style paints it. It opens as a slide viewer in Bee Flow and downloads as .pptx or PDF. Prefer create_presentation when the user just wants a deck now; use this when they want a reusable slide TEMPLATE with {{placeholders}} for automations.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'A short human-readable title, e.g. "Factuur 2026-014 — Van Dijk Groep".',
                    },
                    docType: {
                        type: 'string',
                        // A page is written in the rich-text editor and made from a
                        // project; what the chat creates is designed (body + css).
                        enum: documentStore.DOC_TYPES.filter((/** @type {string} */ t) => t !== 'page' && t !== 'spreadsheet'),
                        description: 'What kind of document this is. Used for the icon and grouping in the Documents list; it does not change how the document renders.',
                    },
                    description: {
                        type: 'string',
                        description: 'Optional one-sentence description.',
                    },
                    useHouseStyle: {
                        type: 'boolean',
                        description: "Whether this document wears the organisation's letterhead (logo, brand colour, fonts). Defaults to TRUE and you should almost always leave it alone. Pass false ONLY when the user explicitly asks for a document in someone else's branding, or for a plain unbranded one — never because you think the design would look better without it.",
                    },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_read',
            description: 'Read a document\'s current slots. Returns { name, docType, bodyHtml, css }.\n\nFor a PAGE it also returns openSuggestions: [{ id, summary }], changes already proposed and not yet accepted, so you do not propose the same thing twice.\n\nUse it before editing a document you did not write this turn — including one the user has since changed by hand, which is the common case: they moved a line or corrected an amount and are now asking you to change something else. Writing without reading would silently revert their edit.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to read.' }, tab: { type: 'string', description: 'SPREADSHEETS ONLY: the tab to read, by id or name (any case). Default: the first tab. The answer lists all tabs.' }, mode: { type: 'string', enum: ['outline'], description: 'SPREADSHEETS ONLY: "outline" answers with every tab\'s columns (header, type, fill, min/max, category values) and no rows. Start here for a dashboard, pivot or summary.' }, range: { type: 'string', description: 'SPREADSHEETS ONLY: read just this part of the tab, e.g. "A1:F30". A large tab without a range answers with its first rows.' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_write',
            description: 'Replace a WHOLE slot. Use this to fill a new document, or for a redesign that rewrites the stylesheet from scratch.\n\nFor any change to a document that already has content — a corrected amount, an extra line, a different colour — use `document_edit` instead. A full rewrite costs the entire document in output tokens and, worse, silently discards whatever the user changed by hand since you last read it.\n\nPass `bodyHtml`, `css`, or both; an omitted slot is left exactly as it is.\n\n`bodyHtml` is BODY MARKUP ONLY — no <html>, <head>, <body> or <style> tags, and no <script> (scripts are stripped: a document does not run). `css` is the full stylesheet, and it owns the paper: set `@page { size: A4; margin: 18mm 16mm; }` (or whatever the document needs) there.\n\nWrite semantic markup with classes — <table class="lines">, <div class="totals"> — and do the layout in `css`. That is what lets the user hand-edit the text afterwards without the layout coming apart.\n\nA PAGE that is not yours alone (filed in a project, shared, or open for others) is never changed directly: your body becomes SUGGESTIONS the user accepts one by one, and the result says { suggested, batchId }. Do not claim they are applied.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to write to.' }, tab: { type: 'string', description: 'SPREADSHEETS ONLY: the tab to write cells to, by id or name (any case). Default: the first tab.' }, createTab: { type: 'boolean', description: 'SPREADSHEETS ONLY: true adds `tab` as a NEW tab when the sheet has none by that name (e.g. a summary or pivot table next to the data), then writes the cells there.' }, charts: { type: 'array', description: 'SPREADSHEETS ONLY: charts to place IN the sheet, on `tab`, drawn from ITS cells (all ranges on that tab): [{ type: "bar"|"hbar"|"line"|"area"|"pie"|"doughnut"|"scatter"|"stacked"|"kpi", dataRange: "B2:C10" (numbers; each column a series; kpi = one cell), categoriesRange: "A2:A10" (labels; numeric x for scatter), anchor: "E2", size: { cols: 6, rows: 14 }, title, format: "number"|"currency"|"percent", label + compareRange (kpi) }]. An item with an existing chart `id` updates it. `cells` may be left out.', items: { type: 'object' } }, removeCharts: { type: 'array', description: 'SPREADSHEETS ONLY: ids of charts on `tab` to delete (document_read lists them).', items: { type: 'string' } },
                    bodyHtml: { type: 'string', description: 'The document body markup. Omit to leave the current body untouched.' },
                    css: { type: 'string', description: 'The document stylesheet. Omit to leave the current stylesheet untouched.' },
                    summary: { type: 'string', description: 'A short note for the version history, e.g. "Added VAT row".' },
                    cells: { type: 'object', additionalProperties: { type: 'string' }, description: 'SPREADSHEETS ONLY (docType "spreadsheet", which has no bodyHtml or css): the cells to set, e.g. { "A1": "Rent", "B1": "1200", "B3": "=SUM(B1:B2)" }. Columns A–Z, rows from 1; "" clears a cell. At most 5000 cells per call.' },
                },
                required: ['documentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_edit',
            description: 'PREFERRED tool for changing an existing document. Replaces a specific snippet inside ONE slot and leaves everything else exactly as it was.\n\nUse it for both of the things people ask for most:\n  • TEXT — "change the amount to 1.320", "add a line for transport", "fix the address". Edit `slot: "body"`.\n  • STYLING ONLY — "make the header green", "bigger totals", "more space above the table". Edit `slot: "css"`; the text is not touched at all.\n\nWorkflow: `document_read` FIRST to see the exact current content, then copy find_text verbatim from what you read. find_text must match EXACTLY ONCE by default; on several matches the tool refuses and lists the line numbers, so either narrow the snippet or pass replace_all: true.\n\nINSERT by anchoring on a stable nearby snippet and repeating it in replace_text. DELETE by passing replace_text: "".\n\nPrefer several small edits over one rewrite — each one shows the user exactly what changed, and an edit that no longer matches tells you the user has hand-edited that part rather than silently overwriting them.\n\nOn a PAGE that is not yours alone the edit becomes a SUGGESTION the user accepts in the document ({ suggested, batchId } in the result); do not claim it is applied.',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document to edit.' },
                    slot: {
                        type: 'string',
                        enum: ['body', 'css'],
                        description: '"body" for the markup and its text, "css" for the stylesheet. Editing one never touches the other.',
                    },
                    find_text: { type: 'string', description: 'The exact text to find, copied verbatim from document_read. Whitespace-normalized matching is a fallback when verbatim fails.' },
                    replace_text: { type: 'string', description: 'What to put in its place. Empty string deletes.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence. Default false — a single match is required.' },
                    summary: { type: 'string', description: 'A short note for the version history, e.g. "Corrected the VAT total".' },
                },
                required: ['documentId', 'slot', 'find_text', 'replace_text'],
            },
        },
    },
];

for (const tool of DOCUMENT_TOOLS) {
    const props = tool.function.parameters.properties;
    if (tool.function.name === 'create_document') {
        props.kind = { type:'string',enum:['document','template','section'] };
        props.settings = { type:'object',description:'Document settings including contract:{instructions,parameters:[{key,type,label,required,summary,instructions,example,default,fields}],sections:[{id,title,summary,condition}]}, and design controls. Section IDs correspond to data-doc-section attributes. Types: text, number, boolean, date, choice, list.' };
    }
    if (['document_write','document_edit'].includes(tool.function.name)) props.expectedVersionId = {type:'string',description:'versionId returned by document_read; protects concurrent edits.'};
    if (tool.function.name === 'document_write') props.settings = {type:'object',description:'Settings including the typed document contract. Preserve unrelated settings from document_read.'};
}

DOCUMENT_TOOLS.push(require('./sheetDownloadTool').DOCUMENT_DOWNLOAD_TOOL);
const DOCUMENT_TOOL_NAMES = new Set(DOCUMENT_TOOLS.map(t => t.function.name));

module.exports = { DOCUMENT_TOOLS, DOCUMENT_TOOL_NAMES };
