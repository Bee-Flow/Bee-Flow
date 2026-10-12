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
 * WHERE THE FILE GOES. Under the caller's own storage prefix
 * (`users/<id>/documents/`), served by the storage proxy, which enforces the
 * session, the prefix and a traversal guard and sends the bytes as an
 * attachment. No ledger row and no expiry, for the same reason as a deck: the
 * link lives in the chat history. With `nextcloudPath` the dispatcher first
 * runs the Nextcloud scope guard and then asks this module to put the file in
 * Nextcloud instead (uploadToNextcloud below); a Nextcloud that refuses still
 * gets the user a download link.
 *
 * Art. 50(2): the body is model output by definition, so the org's AI-Act
 * marking (core/automationRunner/documentMarking.js) is applied like it is to
 * every other generated document.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const WORD_DOCUMENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_word_document',
            description: 'Build a REAL, editable Word document (.docx) in the organisation\'s Word house style (fonts, headings, margins, header and footer) — it opens in Word, LibreOffice, Google Docs and Nextcloud Office. Use it whenever the user asks for "a Word document", "a .docx", "a Word file" or a document they want to EDIT further. For a formatted print or PDF (an invoice, a quote, a certificate) use create_document instead; for slides use create_presentation. Write the content as `markdown`: headings ("#", "##", "###"), paragraphs, lists, tables, bold/italic, links. Returns { downloadUrl, filename } — END YOUR REPLY with a markdown link [filename](downloadUrl) so the user can download it. WHEN THE USER WANTS THE FILE IN NEXTCLOUD (names Nextcloud or a folder like /Documents): pass `nextcloudPath` — the document is saved THERE (parent folders are created; do not create them yourself) and the result has `webUrl` to give as "Open in Nextcloud Office".',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'The document title, shown at the top and used for the file name.' },
                    markdown: { type: 'string', description: 'The document body in Markdown. Do not repeat the title as the first heading.' },
                    fileName: { type: 'string', description: 'Optional file name, e.g. "offerte-acme.docx". Derived from the title when omitted.' },
                    houseStyle: { type: 'boolean', description: "Defaults to TRUE — the organisation's Word house style. Pass false ONLY when the user explicitly asks for an unbranded or neutral document." },
                    nextcloudPath: { type: 'string', description: 'Save into the user\'s Nextcloud at this path — a folder ("/Documents") or a file path ("/Documents/offerte-acme.docx"). Use it whenever the user mentions Nextcloud or a folder.' },
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
 * The Nextcloud destination for `nextcloudPath`: a path ending in .docx is
 * the file itself, anything else is the folder the file goes into.
 */
function nextcloudDocxPath(nextcloudPath, args = {}) {
    // Only a string is a path (as for create_presentation): `true` from the
    // model must not become the folder "true".
    const p = typeof nextcloudPath === 'string' ? nextcloudPath.trim() : '';
    if (!p) return '';
    if (/\.docx$/i.test(p)) return p;
    return `${p.replace(/\/+$/, '')}/${safeWordFileName(args.fileName || args.title)}`;
}

/**
 * Render the .docx. Returns { buffer, filename, title, houseStyle, marking }
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

    const { renderDocument } = require('../services/documentRenderer');
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
        houseStyle: style ? style.name || true : false,
        marking: out.marking,
    };
}

/**
 * Put a built .docx in the user's Nextcloud at `path` (parent folders are
 * created). The caller has already run the Nextcloud scope guard for `path`.
 * Returns the upload result plus a `/f/<id>` deep link when one can be built,
 * or { error }.
 */
async function uploadToNextcloud(built, ctx, path) {
    const ncClient = require('./nextcloudClient');
    const { uploadBinaryFile } = require('./nextcloudFiles/webdav');
    let auth;
    try {
        auth = await ncClient.resolveAuth(ctx.session, ctx.userId);
    } catch (e) {
        return { error: e.message || 'Nextcloud is not connected.' };
    }
    const { baseUrl, fetch: ncFetch, authError, uid } = auth;
    const root = ncClient.webdavRoot(baseUrl, uid);
    let up;
    try {
        up = await uploadBinaryFile(ncFetch, root, path, built.buffer, built.contentType, authError, { wantFileId: true, baseUrl, uid });
    } catch (e) {
        // An unreachable host throws instead of answering { error }. The
        // caller then keeps the file in Bee Flow storage: never lost.
        log.warn(`[WordDocumentTools] Nextcloud upload failed: ${e.message}`);
        return { error: 'Nextcloud upload failed' };
    }
    if (up.error) return up;

    // The deep link a person can open. In connector mode `baseUrl` is the
    // ExApp proxy, so only the org's public URL qualifies (as for a deck).
    const linkBase = auth.publicBaseUrl || (auth.mode !== 'connector' ? String(baseUrl || '').replace(/\/+$/, '') : null);
    const fileId = up.fileId || null;
    return { ...up, fileId, webUrl: linkBase && fileId ? `${linkBase}/f/${fileId}` : null };
}

/**
 * Build the .docx and hand it over: into Nextcloud when `ctx.nextcloudPath`
 * is set (the dispatcher resolved it and ran the scope guard), otherwise, or
 * when Nextcloud refuses, into Bee Flow storage with a download link.
 *
 * @param {object} args   tool arguments
 * @param {{ userId: string, orgId?: string|null, session?: object, provider?: string, nextcloudPath?: string, nextcloudError?: string }} ctx
 *   `nextcloudError`: the scope guard refused `nextcloudPath`; keep the file in storage and say why.
 */
async function executeWordDocumentTool(args = {}, ctx = {}) {
    const userId = ctx.userId;
    if (!userId) return { error: 'No user context for the Word document tool.' };

    const built = await buildWordDocument(args, ctx);
    if (built.error) return built;
    const styled = built.houseStyle ? ' in the house style' : '';

    let ncError = ctx.nextcloudError || null;
    if (ctx.nextcloudPath && !ncError) {
        const path = ctx.nextcloudPath;
        const up = await uploadToNextcloud(built, ctx, path);
        if (!up.error) {
            const name = path.split('/').pop();
            return {
                ...up,
                filename: name,
                houseStyle: built.houseStyle,
                marking: built.marking,
                file: { kind: 'word', name, mimeType: built.contentType, size: built.buffer.length, path, webUrl: up.webUrl, source: 'create_word_document' },
                message: up.webUrl
                    ? `Saved ${path}${styled}. Tell the user: [Open in Nextcloud Office](${up.webUrl}).`
                    : `Saved ${path}${styled} to Nextcloud.`,
            };
        }
        ncError = up.error;
    }

    const storageStore = require('../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        return { error: ncError
            ? `The Word document could not be saved to Nextcloud (${ncError}), and file storage is not available on this server either.`
            : 'File storage is not available on this server, so the Word document cannot be kept. Ask an administrator to configure storage, or save it into Nextcloud by passing nextcloudPath.' };
    }

    const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const key = storageStore.buildKey(userId, 'documents', `${stamp}_${built.filename}`);
    await storageStore.uploadFile(key, built.buffer, built.contentType);
    const downloadUrl = storageStore.buildProxyUrl(key);

    return {
        success: true,
        downloadUrl,
        filename: built.filename,
        size: built.buffer.length,
        houseStyle: built.houseStyle,
        marking: built.marking,
        ...(ncError ? { nextcloud: { error: ncError } } : {}),
        // The card the chat shows under the reply, whatever the model writes.
        file: { kind: 'word', name: built.filename, mimeType: built.contentType, size: built.buffer.length, url: downloadUrl, source: 'create_word_document' },
        message: `Word document "${built.title || built.filename}" built${styled}.`
            + (ncError ? ` It could NOT be saved to Nextcloud (${ncError}) — tell the user.` : '')
            + ` Reply with the download link [${built.filename}](${downloadUrl}).`,
    };
}

module.exports = {
    WORD_DOCUMENT_TOOLS,
    isWordDocumentTool,
    executeWordDocumentTool,
    nextcloudDocxPath,
    safeWordFileName,
};
