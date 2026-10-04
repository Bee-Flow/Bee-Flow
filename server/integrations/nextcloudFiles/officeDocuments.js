/**
 * Generated Office files — build a real spreadsheet, word-processor document
 * or presentation from tool arguments and PUT it into the user's Nextcloud.
 *
 * `nextcloud_create_spreadsheet` can also APPEND to a spreadsheet that already
 * exists (ifExists: "append"), so an automation can keep a running ledger — an
 * invoice list, a log — that grows run over run instead of being replaced.
 *
 * `nextcloud_create_presentation` renders through services/presentationRenderer
 * (the org's house style, the deck model, the AI-Act marking) and answers with
 * the `/f/<fileId>` deep link that opens the deck in Nextcloud Office.
 */

const XLSX = require('@e965/xlsx');
const JSZip = require('jszip');
const officegen = require('../officegen');
const { joinDavPath, uploadBinaryFile } = require('./webdav');
const log = require('../../telemetry/log');

const IF_EXISTS_MODES = ['overwrite', 'append'];

// Both .xlsx and .ods are ZIP packages, so every file this tool can append to
// starts with the local-file-header signature. The check matters because
// XLSX.read does NOT reject arbitrary bytes: anything that is not a ZIP/CFB it
// happily parses as delimited TEXT and returns a "Sheet1" — a CSV, a PDF or a
// plain-text note saved under a .xlsx name would come back as a one-column
// spreadsheet and be overwritten with the text mangled into cells.
function isZipPackage(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// Empty ODF stylesheet, see readWorkbook for why it exists.
const EMPTY_ODS_STYLES =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>';

// Parse an existing .xlsx/.ods into a SheetJS workbook, or throw with a reason
// the user can act on.
async function readWorkbook(buffer) {
    if (!isZipPackage(buffer)) throw new Error('it is not an .xlsx/.ods package (no ZIP signature)');
    let workbook;
    try {
        workbook = XLSX.read(buffer, { type: 'buffer' });
    } catch (e) {
        // officegen.buildOds writes the SMALLEST valid ODF package: mimetype,
        // manifest and content.xml. SheetJS's ODS parser insists on a
        // styles.xml as well, so the very file this tool created on run 1
        // would be unreadable on run 2. Patch an empty stylesheet in and retry
        // — only for that specific failure; files from Nextcloud Office or
        // LibreOffice always carry a styles.xml and never take this path.
        if (!/styles\.xml/.test(e.message)) throw e;
        const zip = await JSZip.loadAsync(buffer);
        zip.file('styles.xml', EMPTY_ODS_STYLES);
        workbook = XLSX.read(await zip.generateAsync({ type: 'nodebuffer' }), { type: 'buffer' });
    }
    if (!workbook.SheetNames.length) throw new Error('it has no worksheets');
    return workbook;
}

/**
 * Append `rows` below the existing content of worksheet `ws`, in place.
 *
 * Object rows are matched to the EXISTING header by column name — the caller's
 * key order is irrelevant, what matters is which column already holds
 * "amount". Keys the header does not know get new columns on the right and
 * only those header cells are written, so the existing header cells (and any
 * formatting on them) are left alone. Array rows are appended verbatim.
 *
 * On an empty sheet there is no header to match, so the rows are laid out
 * exactly as a fresh file would be (`rowsToMatrix`, honouring `columns`).
 */
function appendRows(ws, rows, columns) {
    const existing = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!existing.length) {
        XLSX.utils.sheet_add_aoa(ws, officegen.rowsToMatrix(rows, columns), { origin: 'A1' });
        return;
    }
    // The origin is computed by hand rather than `origin: -1`: SheetJS
    // resolves -1 to column 0 regardless of where the used range starts,
    // and to a bogus row 0 on a sheet without a range.
    const range = XLSX.utils.decode_range(ws['!ref']);
    const nextRow = { r: range.e.r + 1, c: range.s.c };

    if (rows.every((r) => Array.isArray(r))) {
        XLSX.utils.sheet_add_aoa(ws, rows.map((r) => r.map(officegen.coerceCell)), { origin: nextRow });
        return;
    }

    // Header cells may be numbers (year columns); object keys are strings.
    const header = existing[0].map((h) => String(h));
    const added = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        for (const k of Object.keys(r)) {
            if (!header.includes(k)) { header.push(k); added.push(k); }
        }
    }
    if (added.length) {
        XLSX.utils.sheet_add_aoa(ws, [added], { origin: { r: range.s.r, c: range.e.c + 1 } });
    }
    const matrix = rows.map((r) => header.map((h) => officegen.coerceCell(r && typeof r === 'object' ? r[h] : undefined)));
    XLSX.utils.sheet_add_aoa(ws, matrix, { origin: nextRow });
}

// Download the current file, add the rows, write the whole workbook back.
// Returns `{ error }`, `{ notFound: true }` (caller creates a fresh file) or
// `{ buffer, contentType }`.
async function buildAppendedSpreadsheet({ ncFetch, authError, root }, path, args, format) {
    const res = await ncFetch(joinDavPath(root, path), {});
    if (res.status === 404) return { notFound: true };
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Could not read the existing spreadsheet (${res.status})` };

    const current = Buffer.from(await res.arrayBuffer());
    let workbook;
    try {
        workbook = await readWorkbook(current);
    } catch (e) {
        // A file we cannot parse is a hard error, never a silent overwrite:
        // the caller asked to APPEND, so the existing content is by definition
        // something they want to keep. Replacing it would destroy exactly the
        // data "append" was chosen to protect.
        return { error: `The existing file at ${path} is not a spreadsheet this tool can append to: ${e.message}` };
    }

    const sheetName = args.sheetName && workbook.Sheets[args.sheetName] ? args.sheetName : workbook.SheetNames[0];
    appendRows(workbook.Sheets[sheetName], args.rows, args.columns);

    // Written by SheetJS rather than officegen's writer: the in-house builder
    // only knows how to lay out ONE sheet from a matrix, whereas the existing
    // workbook may hold other tabs (and cell types) that must survive the
    // round trip. The output format follows the path, as it does on create.
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: format });
    return { buffer, contentType: officegen.CONTENT_TYPES[format] };
}

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
async function executeOfficeDocumentTool(toolName, args, ctx) {
    const { ncFetch, authError, root } = ctx;

    switch (toolName) {
        case 'nextcloud_create_spreadsheet': {
            if (!args.path) return { error: 'path is required' };
            if (!Array.isArray(args.rows) || args.rows.length === 0) return { error: 'rows must be a non-empty array (of row objects, or arrays of cells)' };
            const ifExists = args.ifExists == null ? 'overwrite' : args.ifExists;
            if (!IF_EXISTS_MODES.includes(ifExists)) return { error: 'ifExists must be "overwrite" or "append"' };
            const format = officegen.resolveOfficeFormat(args.format, args.path, ['xlsx', 'ods'], 'xlsx');
            const path = officegen.ensureExt(args.path, format);

            if (ifExists === 'append') {
                const appended = await buildAppendedSpreadsheet(ctx, path, args, format);
                if (appended.error) return { error: appended.error };
                if (!appended.notFound) {
                    const up = await uploadBinaryFile(ncFetch, root, path, appended.buffer, appended.contentType, authError);
                    return up.error ? up : { ...up, appended: args.rows.length };
                }
                // No file yet: the first run of a ledger simply creates it.
            }

            let gen;
            try {
                const matrix = officegen.rowsToMatrix(args.rows, args.columns);
                gen = await officegen.buildSpreadsheet({ matrix, sheetName: args.sheetName, format });
            } catch (e) {
                return { error: `Could not build the spreadsheet: ${e.message}` };
            }
            const up = await uploadBinaryFile(ncFetch, root, path, gen.buffer, gen.contentType, authError);
            // Only the append path reports `appended`; the overwrite result is
            // the same object it always was, so existing automations see no change.
            return ifExists === 'append' && !up.error ? { ...up, appended: 0 } : up;
        }

        case 'nextcloud_create_document': {
            if (!args.path) return { error: 'path is required' };
            if (args.content === undefined || args.content === null) return { error: 'content is required' };
            const format = officegen.resolveOfficeFormat(args.format, args.path, ['docx', 'odt'], 'docx');
            const path = officegen.ensureExt(args.path, format);
            let gen;
            try {
                gen = await officegen.buildDocument({ content: String(args.content), title: args.title, format });
            } catch (e) {
                return { error: `Could not build the document: ${e.message}` };
            }
            return await uploadBinaryFile(ncFetch, root, path, gen.buffer, gen.contentType, authError);
        }

        case 'nextcloud_create_presentation': {
            if (!args.path) return { error: 'path is required' };
            const hasSlides = Array.isArray(args.slides) && args.slides.length > 0;
            const hasMarkdown = typeof args.markdown === 'string' && args.markdown.trim().length > 0;
            if (!hasSlides && !hasMarkdown) return { error: 'Give the deck as `slides` (an array of { title, bullets, notes }) or as `markdown` (an outline with "## " per slide).' };
            const path = officegen.ensureExt(args.path, 'pptx');
            const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';

            // Art. 50(2): a deck written by the model is model output; whether
            // the org marks it is answered through the core port.
            let marking = null;
            try {
                const { resolveMarking } = require('../../core/automationRunner/documentMarking');
                marking = await resolveMarking(ctx.orgId || null, { automationId: null, aiStepIds: [], provider: 'chat' });
            } catch (e) {
                log.warn(`[nextcloud_create_presentation] marking unavailable, rendering unmarked: ${e.message}`);
            }

            // A template deck for THIS deck: a .pptx in the user's Nextcloud
            // whose first slides carry the design. Read through the same
            // scope-guarded WebDAV access as any other file; its look rides
            // along as a theme override, so the house style steps back.
            const theme = args.theme && typeof args.theme === 'object' ? { ...args.theme } : {};
            if (typeof args.templatePath === 'string' && args.templatePath.trim()) {
                const tplPath = args.templatePath.trim();
                const res = await ncFetch(joinDavPath(root, tplPath), {});
                if (res.status === 404) return { error: `Template deck not found: ${tplPath}` };
                if (res.status === 401) return { error: authError };
                if (!res.ok) return { error: `Nextcloud read of the template deck failed (${res.status})` };
                try {
                    const { extractDeckTemplate } = require('../../core/documents/pptxTemplate');
                    theme.template = await extractDeckTemplate(Buffer.from(await res.arrayBuffer()), { name: tplPath.split('/').pop() });
                } catch (e) {
                    return { error: `The template deck could not be used: ${e.message}` };
                }
            }

            const { renderPresentation, makeUserImageResolver } = require('../../services/presentationRenderer');
            let out;
            try {
                out = await renderPresentation({
                    deck: hasSlides ? { title, subtitle: args.subtitle, slides: args.slides } : { title, subtitle: args.subtitle, markdown: args.markdown },
                    title,
                    orgId: ctx.orgId || null,
                    houseStyle: args.houseStyle !== false,
                    theme: Object.keys(theme).length ? theme : null,
                    marking,
                    resolveImage: makeUserImageResolver(ctx.userId),
                });
            } catch (e) {
                if (e && e.errorClass) return { error: `Could not build the presentation: ${e.message}` };
                throw e;
            }

            const up = await uploadBinaryFile(ncFetch, root, path, out.buffer, out.contentType, authError, {
                wantFileId: true, baseUrl: ctx.baseUrl, uid: ctx.uid,
            });
            if (up.error) return up;

            // The deep link a person can open. In connector mode `baseUrl` is
            // the ExApp proxy, so only the org's public URL qualifies.
            const linkBase = ctx.publicBaseUrl || (ctx.mode !== 'connector' ? String(ctx.baseUrl || '').replace(/\/+$/, '') : null);
            const fileId = up.fileId || null;
            const webUrl = linkBase && fileId ? `${linkBase}/f/${fileId}` : null;
            // The deck also lives in Studio → Documents (with its template),
            // so it opens in Bee Flow and can be rebuilt without Nextcloud.
            const kept = args.saveToLibrary === false ? null : await require('../../core/documents/deckDocument').keepDeckInLibrary({
                userId: ctx.userId, deck: out.deck, title: title || path.split('/').pop().replace(/\.pptx$/i, ''),
                theme: Object.keys(theme).length ? theme : null, houseStyle: args.houseStyle !== false, source: 'nextcloud_create_presentation',
            });
            const warn = out.warnings.length ? ` Notes: ${out.warnings.slice(0, 5).join('; ')}.` : '';
            return {
                ...up,
                fileId,
                webUrl,
                slideCount: out.slideCount,
                houseStyle: out.houseStyle,
                marking: out.marking,
                warnings: out.warnings,
                ...(kept ? { documentId: kept.documentId, documentUrl: kept.url } : {}),
                // The card the chat shows under the reply — whatever the model
                // writes, the person sees where the deck went.
                file: { kind: 'presentation', name: path.split('/').pop(), mimeType: out.contentType, size: out.buffer.length, slideCount: out.slideCount, path, webUrl, source: 'nextcloud_create_presentation', ...(kept ? { documentId: kept.documentId, documentUrl: kept.url } : {}) },
                message: (webUrl
                    ? `Saved ${path} (${out.slideCount} slides). Tell the user: [Open in Nextcloud Office](${webUrl}).`
                    : `Saved ${path} (${out.slideCount} slides) to Nextcloud.`)
                    + (kept ? ` It is also in Studio → Documents: [${kept.name}](${kept.url}) opens the slides in Bee Flow.` : '') + warn,
            };
        }

        default:
            return undefined;
    }
}

module.exports = { executeOfficeDocumentTool };
