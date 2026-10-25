// @typecheck strict
/**
 * Keeping what a finished journey produced: a generated document opened in a
 * new notebook, and the closing page's own text saved as a notebook, exported
 * as a Word or PDF file, or turned into a new webpage. Every route here reads
 * the result from the RUN (token → session → journey), never from the request.
 */

const log = require('../../../telemetry/log');
const { HttpError } = require('../../../core/http/errors');
const automationStore = require('../../../stores/automationStore');
const storageStore = require('../../../stores/storageStore');
const notebookStore = require('../../../stores/notebookStore');
const { contentDisposition } = require('../../../core/http/contentDisposition');
const { endingFrom, resultOf, markdownToSafeHtml, webpageSlots, aiStepsOf, resultFilename } = require('../../../automation/formResult');
const { privateHeaders, loadForm, loadSession, currentRunFor, journeyRunIds } = require('./access');
const { ipLimiter, sessionLimiter, exportLimiter } = require('./limits');
const { friendly } = require('./friendly');

/**
 * POST /form/:token/s/:sid/file/:fileId/notebook — put this document's TEXT
 * into a new notebook and say which one, so the page can open it.
 *
 * The closing page's "Open in Notebooks" button. It is the download route's
 * twin: same token → session → journey-runs → generated-file chain, so a file
 * belonging to somebody else's journey is a 404 here exactly as it is there.
 *
 * The document lands as the notebook's own CONTENT, not as an attached source.
 * A source is something you ask questions ABOUT; this is the thing the automation
 * just wrote, and the point of sending it here is to carry on working on it.
 * (It was a source first, and arrived as a file card you could not edit.)
 *
 * Nothing kept the text: automation_generated_files stores only the rendered
 * PDF/Word, so it is parsed back out. Lossy for a PDF by nature — Word keeps
 * its structure through mammoth, a PDF comes back as prose.
 *
 * A new notebook every time, named after the document. Reusing one would mean
 * guessing which of the caller's notebooks was meant and quietly writing into
 * it; a fresh one is the only outcome that cannot surprise them.
 *
 * Only reachable while forms are signed-in only — it needs a real user to own
 * the notebook. That is the same condition the router's requireAuth enforces,
 * asserted here so flipping PUBLIC_FORMS_ENABLED back on cannot silently
 * produce ownerless notebooks.
 * @param {import('express').Request<{ token: string, sid: string, fileId: string }>} req
 * @param {import('express').Response} res
 */
async function openFileInNotebooks(req, res) {
    privateHeaders(res);
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const found = await loadForm(req, res);
    if (!found) return undefined;
    const loaded = await loadSession(found, req.params.sid);
    if (!loaded || loaded.expired) return res.status(404).json({ error: 'Not found' });

    const runIds = await journeyRunIds(loaded.session);
    if (runIds.length === 0) return res.status(404).json({ error: 'Not found' });
    const file = await automationStore.getGeneratedFileForRuns(req.params.fileId, runIds);
    if (!file) return res.status(404).json({ error: 'Not found' });

    let buffer;
    try {
        const streamed = await storageStore.streamFile(file.storageKey);
        const chunks = [];
        for await (const chunk of streamed.stream) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
    } catch (e) {
        // Same race the download route documents: the reaper drops blobs
        // before rows, so a live row with no bytes is not a server fault.
        log.warn(`[automation/form] generated file ${file.id} has no bytes: ${e.message}`);
        return res.status(404).json({ error: 'Not found' });
    }

    // `returnHtml` so a Word document keeps its headings and lists; a PDF
    // ignores it and comes back as text, which documentHtml then wraps.
    const { parseDocument } = require('../../../core/documents/documentParser');
    let parsed;
    try {
        parsed = await parseDocument(buffer, file.mimeType, file.filename, { returnHtml: true });
    } catch (e) {
        log.warn(`[automation/form] could not read ${log.nameForLog(file.filename)} for Notebooks: ${e.message}`);
        return res.status(422).json({ error: 'This document could not be read into Notebooks.' });
    }

    const notebook = await notebookStore.createNotebook({
        userId,
        name: notebookNameFor(file.filename, found),
        description: '',
        instructions: '',
        organizationId: req.session?.user?.organizationId || null,
    });
    // createNotebook always starts empty, so the content is a second write.
    const html = documentHtml(parsed);
    await notebookStore.updateNotebook(notebook.id, userId, { documentContent: html });
    await recordImportedVersion(notebook.id, userId, html);

    return res.json({ notebookId: notebook.id });
}

/**
 * The finished journey's result — the closing page's title and markdown, as
 * the RUN recorded them — or null after answering 404.
 *
 * Shared by every "keep this result" route below (BFSF-419). None of them
 * takes the text from the request: the page could send anything, and these
 * routes write a notebook, a webpage or a rendered document from it. Reading
 * the ending back from the run means a visitor keeps exactly what their own
 * journey produced. Same scoping as the file routes above (token → session),
 * so a wrong, foreign or expired session id is the same 404 as everywhere
 * else in this file, and so is a journey that has not finished, or finished
 * without a closing text.
 * @param {import('express').Request<{ token: string, sid: string }>} req
 * @param {import('express').Response} res
 */
async function loadResult(req, res) {
    const found = await loadForm(req, res);
    if (!found) return null;
    const loaded = await loadSession(found, req.params.sid);
    const run = loaded && !loaded.expired ? await currentRunFor(loaded.session) : null;
    const result = run?.status === 'success' ? resultOf(endingFrom(await automationStore.getRunSteps(run.id))) : null;
    if (!result) { res.status(404).json({ error: 'Not found' }); return null; }
    const title = (result.title || found.trigger?.form?.title || found.automation?.title || 'Result').slice(0, 120);
    return { found, result: { ...result, title } };
}

/**
 * POST /form/:token/s/:sid/notebook — save the closing page's text into a new
 * notebook and say which one, so the page can open it.
 *
 * The route above needs a fileId because a `generate_document` step left
 * something in storage to fetch and reparse. Most automations never take that
 * step: the "result" is just the ending page's markdown (a blog post, a
 * summary, an analysis). That markdown becomes the notebook's HTML, headings,
 * lists and tables included, so the notebook looks like the page the visitor
 * just read rather than a wall of `##` and `|`.
 *
 * Signed-in only (the router's requireAuth while PUBLIC_FORMS_ENABLED is off,
 * and asserted here so flipping it back on cannot silently produce an
 * ownerless notebook).
 * @param {import('express').Request<{ token: string, sid: string }>} req
 * @param {import('express').Response} res
 */
async function saveResultToNotebook(req, res) {
    privateHeaders(res);
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const loaded = await loadResult(req, res);
    if (!loaded) return undefined;
    const { result } = loaded;

    const notebook = await notebookStore.createNotebook({
        userId,
        name: result.title,
        description: '',
        instructions: '',
        organizationId: req.session?.user?.organizationId || null,
    });
    // createNotebook always starts empty, so the content is a second write.
    const html = markdownToSafeHtml(result.markdown);
    await notebookStore.updateNotebook(notebook.id, userId, { documentContent: html });
    await recordImportedVersion(notebook.id, userId, html);

    return res.json({ notebookId: notebook.id });
}

/**
 * GET /form/:token/s/:sid/export/:format — the closing page's text as a Word
 * or PDF file.
 *
 * The same renderer generate_document uses (core/documents/render/documentRenderer), so a
 * result downloaded here looks like a document an automation produced on purpose,
 * and the PDF falls back to pdfkit when no browser is reachable instead of
 * failing. Nothing is stored: the file is rendered for this response only.
 *
 * AI marking (Art. 50(2)) is requested when the automation has an AI step; the
 * organisation's policy (resolveMarking) decides whether it marks at all.
 * @param {import('express').Request<{ token: string, sid: string, format: string }>} req
 * @param {import('express').Response} res
 */
async function exportResult(req, res) {
    privateHeaders(res);
    const { renderDocument, FORMATS } = require('../../../core/documents/render/documentRenderer');
    if (!FORMATS.includes(req.params.format)) return res.status(404).json({ error: 'Not found' });

    const loaded = await loadResult(req, res);
    if (!loaded) return undefined;
    const { found, result } = loaded;

    const marking = await exportMarking(req, found);
    const { buffer, contentType, extension, degraded } = await renderDocument({
        content: result.markdown,
        contentFormat: 'markdown',
        title: result.title,
        format: req.params.format,
        marking,
    });
    if (degraded) log.warn('[automation/form] result PDF rendered without a browser — plain fallback layout.');

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition(resultFilename(result.title, extension)));
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
}

/**
 * The marking for an exported result, or null. A failure to resolve never blocks the download.
 * @param {import('express').Request} req
 * @param {NonNullable<Awaited<ReturnType<typeof loadForm>>>} found
 */
async function exportMarking(req, found) {
    const ai = aiStepsOf(found.automation?.definition);
    if (!ai) return null;
    try {
        const { resolveMarking } = require('../../../core/automationRunner/documentMarking');
        return await resolveMarking(req.session?.user?.organizationId || null, { automationId: found.automation.id, ...ai });
    } catch (e) {
        log.warn(`[automation/form] could not resolve AI content marking, exporting unmarked: ${e.message}`);
        return null;
    }
}

/**
 * Webpages sit behind their module and the organisation's capability
 * (index.js mounts /api/webpages the same way). Required lazily, so this
 * router does not load the module registry when it is loaded itself.
 */
/** @type {import('express').RequestHandler[] | null} */
let webpagesGates = null;
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function webpagesGate(req, res, next) {
    webpagesGates ||= [
        require('../../../modules').requireModule('webpages'),
        require('../../../core/entitlements/entitlements').requireCapability('webpages'),
    ];
    const [moduleGate, capabilityGate] = webpagesGates;
    return moduleGate(req, res, (err) => (err ? next(err) : capabilityGate(req, res, next)));
}

/**
 * POST /form/:token/s/:sid/webpage — turn the closing page's text into a new
 * webpage (index.html + style.css, the vanilla framework) and say which one.
 *
 * A plain, readable article page the visitor can then restyle, extend or
 * publish in the webpage editor. Like the notebook route: a new webpage every
 * time, owned by the caller, never one of theirs written into.
 * @param {import('express').Request<{ token: string, sid: string }>} req
 * @param {import('express').Response} res
 */
async function saveResultAsWebpage(req, res) {
    privateHeaders(res);
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const loaded = await loadResult(req, res);
    if (!loaded) return undefined;
    const { result } = loaded;

    // Webpage files live in object storage. Checked before the row is
    // made, so a missing store leaves no empty webpage behind.
    if (!storageStore.isAvailable()) throw new HttpError(503, 'storage_unavailable', 'Webpages cannot be saved right now.');

    const webpageStore = require('../../../stores/webpageStore');
    const webpage = await webpageStore.createWebpage({
        userId,
        name: result.title,
        description: '',
        settings: { framework: 'vanilla', runtime: 'light' },
    });
    // The same bookkeeping the editor's own save does: each slot's sha and
    // size go on the row, or the editor thinks the page is still empty.
    /** @type {Record<string, unknown>} */
    const metadata = {};
    for (const [slot, content] of Object.entries(webpageSlots(result))) {
        const { sha, size } = await webpageStore.writeSlot(userId, webpage.id, /** @type {'html' | 'css'} */ (slot), content);
        metadata[`${slot}Sha`] = sha;
        metadata[`${slot}Size`] = size;
    }
    await webpageStore.updateWebpageMetadata(webpage.id, userId, metadata);

    return res.json({ webpageId: webpage.id });
}

/**
 * The notebook's first version, 'import': where its history starts. Best-effort
 * — the notebook and its text are already saved.
 * @param {string} notebookId
 * @param {string} userId
 * @param {string} html
 */
async function recordImportedVersion(notebookId, userId, html) {
    try {
        await notebookStore.recordVersion(notebookId, {
            html, source: 'import', createdBy: userId, contributors: [{ userId, kind: 'user' }],
        });
    } catch (e) {
        log.warn(`[automation/form] could not record the imported notebook's first version: ${e.message}`);
    }
}

/**
 * Notebook name: the document's, without its extension, falling back to the form's.
 * @param {string} filename
 * @param {NonNullable<Awaited<ReturnType<typeof loadForm>>>} found
 */
function notebookNameFor(filename, found) {
    const stem = String(filename || '').replace(/\.[^.]+$/, '').trim();
    return (stem || found?.trigger?.form?.title || found?.automation?.title || 'Document').slice(0, 120);
}

/**
 * The notebook editor holds HTML. mammoth already returns some for a Word
 * file; a PDF returns prose, which becomes one paragraph per blank-line-
 * separated block so it does not land as a single wall of text.
 *
 * The escape matters: this text comes out of a document an automation generated,
 * which routinely carries model output, and the editor renders what it is
 * given.
 * @param {string | { html?: string, text?: string } | null | undefined} parsed
 */
function documentHtml(parsed) {
    const text = typeof parsed === 'string' ? parsed : String(parsed?.html || parsed?.text || '');
    if (/<\/?(p|h[1-6]|ul|ol|table|div|br)\b/i.test(text)) return text;
    const escape = (/** @type {string} */ t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return '';
    return blocks.map(b => `<p>${escape(b).replace(/\n/g, '<br />')}</p>`).join('');
}

/**
 * POST …/file/:fileId/notebook, POST …/notebook, GET …/export/:format,
 * POST …/webpage — in that order, between the download and the resume.
 * @param {import('express').Router} router
 */
function register(router) {
    router.post('/form/:token/s/:sid/file/:fileId/notebook', ipLimiter, sessionLimiter, friendly(openFileInNotebooks, 'notebook_open_failed', 'Could not open this in Notebooks'));
    router.post('/form/:token/s/:sid/notebook', ipLimiter, sessionLimiter, friendly(saveResultToNotebook, 'notebook_save_failed', 'Could not save this to Notebooks'));
    router.get('/form/:token/s/:sid/export/:format', ipLimiter, sessionLimiter, exportLimiter, friendly(exportResult, 'export_failed', 'Could not create this file'));
    router.post('/form/:token/s/:sid/webpage', ipLimiter, sessionLimiter, webpagesGate, friendly(saveResultAsWebpage, 'webpage_save_failed', 'Could not save this as a webpage'));
}

module.exports = { register };
