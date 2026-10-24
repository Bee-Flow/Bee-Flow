// @typecheck
/**
 * Word Document Tools — the chat's way to hand the user a real, editable .docx.
 *
 * One tool, `create_word_document`, the sibling of create_presentation (.pptx)
 * and create_document (a rendered Document, printed to PDF): a first-party
 * artefact tool, injected for every signed-in user by
 * core/integrations/integrationTools.js and dispatched by
 * core/tools/toolDispatcher.js. Not a catalog integration: "make this a Word
 * file" is not a connection to a third party.
 *
 * HOUSE STYLE. The org's Word "kantoorstijl" (org_house_styles, the template an
 * admin uploads) dresses the file: fonts, heading sizes, margins, header and
 * footer text. The same helpers the notebook's Word export uses
 * (core/documents/docxHouseStyle.js), so a chat document and an exported
 * notebook look alike. `houseStyle: false` builds a neutral document.
 *
 * WHERE THE FILE GOES. This module only builds the .docx; a download link,
 * Nextcloud (`nextcloudPath`) or OneDrive (`oneDrivePath`) is
 * integrations/officeFileDelivery.js, shared with create_spreadsheet.
 *
 * Art. 50(2): the body is model output by definition, so the org's AI-Act
 * marking (core/automationRunner/documentMarking.js) is applied like it is to
 * every other generated document.
 */

const log = require('../telemetry/log');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const WORD_DOCUMENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_word_document',
            description: 'Build a REAL, editable Word document (.docx) in the organisation\'s Word house style (fonts, headings, margins, header and footer) — it opens in Word, LibreOffice, Google Docs and Nextcloud Office. Use it whenever the user asks for "a Word document", "a .docx", "a Word file" or a document they want to EDIT further. For a formatted print or PDF (an invoice, a quote, a certificate) use create_document instead; for slides use create_presentation. Write the content as `markdown`: headings ("#", "##", "###"), paragraphs, lists, tables, bold/italic, links. WHERE IT GOES: by default the result has { downloadUrl, filename } — END YOUR REPLY with a markdown link [filename](downloadUrl). `nextcloudPath` saves it into Nextcloud (the result has `webUrl`: "Open in Nextcloud Office"), `oneDrivePath` into the user\'s own OneDrive (`webUrl`: "Open in OneDrive"); parent folders are created, never create them yourself. If the user did not say where they want it and Nextcloud or OneDrive tools are available to you, ASK first: a download, OneDrive or Nextcloud.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'The document title, shown at the top and used for the file name.' },
                    markdown: { type: 'string', description: 'The document body in Markdown. Do not repeat the title as the first heading.' },
                    fileName: { type: 'string', description: 'Optional file name, e.g. "offerte-acme.docx". Derived from the title when omitted.' },
                    houseStyle: { type: 'boolean', description: "Defaults to TRUE — the organisation's Word house style. Pass false ONLY when the user explicitly asks for an unbranded or neutral document." },
                    nextcloudPath: { type: 'string', description: 'Save into the user\'s Nextcloud at this path — a folder ("/Documents") or a file path ("/Documents/offerte-acme.docx"). Only when the user asked for Nextcloud.' },
                    oneDrivePath: { type: 'string', description: 'Save into the user\'s own OneDrive at this path — a folder ("/Documents") or a file path. Only when the user asked for OneDrive.' },
                },
                required: ['title', 'markdown'],
            },
        },
    },
];

const WORD_DOCUMENT_TOOL_NAMES = new Set(WORD_DOCUMENT_TOOLS.map((t) => t.function.name));

function isWordDocumentTool(toolName) {
    return WORD_DOCUMENT_TOOL_NAMES.has(toolName);
}

/**
 * A file name that is safe on disk, in a storage key and in a
 * Content-Disposition header. ASCII only, like safePresentationFileName.
 */
function safeWordFileName(raw, fallback = 'document') {
    const base = String(raw || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\.docx$/i, '')
        .replace(/[^A-Za-z0-9._ -]+/g, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/ /g, '-')
        .replace(/^[-.]+/, '')
        .replace(/[-.]+$/, '')
        .slice(0, 80);
    return `${base || fallback}.docx`;
}

/**
 * Render the .docx. Returns { buffer, contentType, filename, title, note, extra }
 * or { error } for anything the model can fix (no content, too large).
 */
async function buildWordDocument(args = {}, ctx = {}) {
    const markdown = typeof args.markdown === 'string' ? args.markdown : '';
    if (!markdown.trim()) {
        return { error: 'Give the document content as `markdown` (headings, paragraphs, lists, tables).' };
    }
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
    const orgId = ctx.orgId || null;

    let style = null;
    if (args.houseStyle !== false && orgId) {
        try {
            const { resolveHouseStyle, NO_SUCH_STYLE } = require('../core/documents/docxHouseStyle');
            const resolved = await resolveHouseStyle(orgId, null);
            style = resolved === NO_SUCH_STYLE ? null : resolved;
        } catch (e) {
            log.warn(`[WordDocumentTools] house style unavailable, rendering neutral: ${e.message}`);
        }
    }

    let marking = null;
    try {
        const { resolveMarking } = require('../core/automationRunner/documentMarking');
        marking = await resolveMarking(orgId, { automationId: null, aiStepIds: [], provider: ctx.provider || 'chat' });
    } catch (e) {
        log.warn(`[WordDocumentTools] marking unavailable, rendering unmarked: ${e.message}`);
    }

    const { renderDocument } = require('../core/documents/render/documentRenderer');
    let out;
    try {
        out = await renderDocument({
            content: markdown,
            contentFormat: 'markdown',
            title,
            format: 'docx',
            marking,
            // Without a house style the renderer's own print stylesheet is the
            // neutral look; with one, its CSS and Word options are layered on.
            docxStyle: style ? require('../core/documents/docxHouseStyle').buildDocxStylingFromHouseStyle(style) : null,
        });
    } catch (e) {
        if (e && e.errorClass) return { error: e.message };
        throw e;
    }

    return {
        buffer: out.buffer,
        contentType: out.contentType || DOCX_MIME,
        filename: safeWordFileName(args.fileName || title),
        title,
        note: style ? ' in the house style' : '',
        extra: { houseStyle: style ? style.name || true : false, marking: out.marking },
    };
}

module.exports = {
    WORD_DOCUMENT_TOOLS,
    isWordDocumentTool,
    buildWordDocument,
    safeWordFileName,
};
