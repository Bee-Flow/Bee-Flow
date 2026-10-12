/**
 * Studio Documents — CRUD, the composed preview, and the PDF download.
 *
 *   GET    /house-style       the organisation's letterhead (any signed-in user)
 *   PUT    /house-style       change it (org_admin)
 *   GET    /templates        list + each document's placeholders (the pickers)
 *   GET    /                 list (no slots — see documentStore.mapListRow)
 *   POST   /                 create
 *   GET    /:id              one document, slots included
 *   PATCH  /:id              patch name/type/description/body/css
 *   DELETE /:id              archive (referenced versions remain available)
 *   GET    /:id/preview      the composed document as text/html, for the editor iframe
 *                            (a presentation: the slide viewer, core/documents/deckDocument.js)
 *   POST   /:id/preview      a presentation drafted but not saved (outline + look) as the viewer
 *   GET    /:id/pdf          the composed document as application/pdf (a presentation: its PDF deck)
 *   GET    /:id/pptx         a presentation as .pptx
 *   POST   /:id/unarchive    back from the archive (the owner)
 *   GET    /:id/stream       live transient events of one document (studioDocuments/stream.js)
 *   *      /:id/suggestions  AI suggestions: list, accept, reject (documentSuggestions.js)
 *   POST   /:id/presence     who else is here, and in which section (studioDocuments/presence.js)
 *   *      /:id/versions     the history: list, read, name, restore, delete (studioDocuments/versions.js)
 *
 * A PAGE (doc_type 'page') is a document written in the rich-text editor: its
 * body is stored sanitised, it prints with the page sheet of
 * core/documents/pageDocument.js, and inside a project it is edited live
 * (server/core/collab), in which case its body is saved by the live layer and
 * a body PATCH is refused (409 document_live) rather than overwritten by the
 * next live save.
 *
 * A SAVE FROM A STALE REVISION with `merge: true` is merged against the
 * revision it started from, section by section (core/documents/sectionMerge.js):
 * the answer carries `merge` ({ merged, fromOthers }); when both sides changed
 * the same part it is a 409 whose `conflict.parts` the editor turns into
 * "compare and choose".
 *
 * WHY /api/studio-documents AND NOT /api/documents. That prefix is taken, by a
 * legacy router that serves PDFs out of a shared temp directory for the mobile
 * app's "Generated" tab (routes/documents.js — a shipped contract). Mounting
 * here alongside it would be worse than ugly: this router's `GET /:id` would
 * swallow that router's `GET /list`. `/api/studio-*` is the existing convention
 * for a Studio section's own API (see /api/studio-apps in index.js).
 *
 * EVERY read checks ownership or explicit same-organization sharing in SQL,
 * so a document id from another tenant is a 404 here rather than a leak — the
 * same line routes/webpagesUsage.js draws.
 *
 * A document filed into a collaborative project (documentStore, project_id) is
 * also readable by every member of that project, and its content editable by
 * the project's editors and owner. The store decides; a document read that way
 * carries `projectRole`, and a viewer who tries to change it is told so (403)
 * instead of being answered as if the document did not exist. Archiving stays
 * with the document's owner.
 *
 * WHY THE PREVIEW IS A ROUTE AND NOT A srcdoc STRING. The editor could compose
 * the document in the browser and hand the iframe a srcdoc. It deliberately
 * does not: composition is where sanitising happens, and a sanitiser that runs
 * in the page it is protecting is a sanitiser an attacker gets to skip. Serving
 * the composed bytes from here means the SAME function that feeds Chromium for
 * the PDF feeds the preview, so what you hand-edit is what prints — and the
 * markup is inert before it ever reaches a browser.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
router.use(require('../stores/lib/documentCrypto').withDocumentEncryptionSession);

const { requireAuth, requirePermission, hasPermission } = require('../auth/permissions');
const documentStore = require('../stores/documentStore');
const { composeDocument } = require('../services/documentCompose');
const houseStyle = require('../core/documents/documentHouseStyle');
const { prepareDocument, getContract } = require('../core/documents/documentContract');
const { extractSection, insertSection } = require('../core/documents/documentSections');
const { houseStyleCssFor: houseStyleCssForDocument } = require('../core/documents/renderFilledDocument');
const { isDeckDocument, renderDeckDocument } = require('../core/documents/deckDocument');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, wholeNumber } = require('../core/http/schemaParts');
const { forCompose } = require('../core/documents/pageDocument');
const { mergeBodies } = require('../core/documents/sectionMerge');
const documentFeed = require('../core/documents/documentFeed');
const { describePeople } = require('../core/documents/documentPeople');
const { wordStats } = require('../stores/lib/documentText');
const notebookLibraryRouter = require('./studioDocuments/notebooks');
const sheetRouter = require('./studioDocuments/sheet');
router.use(require('./studioDocuments/sharing').makeDocumentSharingRouter());
// AI suggestions: GET /:id/suggestions and accept / reject (routes/documentSuggestions.js)
router.use(require('./documentSuggestions').makeDocumentSuggestionsRouter());

// ── What a request may send ──────────────────────────────────────────
// Every query, and every body except three, is closed. What that closes:
// `?docType=invoce` listed EVERY type (an unknown type was dropped, not
// refused); `?limit=abc` became 100; a misspelled `expectedVersionId`
// answered 428 as if the revision had not been read; `mode: "desing"` on the
// assistant quietly ran as design.
//
// Three bodies stay open, on purpose. POST / and PATCH /:id carry a document:
// the editor sends its whole document object back (the "save recovered copy"
// paths spread `...doc`, ids and timestamps included), and
// documentStore.createDocument/updateDocument copy only their own key list
// out of it. PUT /house-style and POST /house-style/preview-theme carry a
// house style, which houseStyle.normaliseStyle reads field by field.
const docText = (message, max) => worded(message).max(max, message);
const anId = (name) => docText(`${name} is the id of a document.`, 200);
// Read when a request arrives, not at load: the list is the store's.
const listTypes = () => [...(documentStore.DOC_TYPES || []), 'designed', 'notebook'];
const DOC_TYPE_TEXT = 'docType is a document type, like page, notebook, invoice, letter or presentation, or designed for every type written in the designer.';
const pageOf = (fallbackText) => ({
    limit: wholeNumber(`limit is a whole number. ${fallbackText}`).optional(),
    offset: wholeNumber('offset is a whole number, 0 or more.').optional(),
});
const listFilters = {
    query: docText('query is text.', 2000).optional(),
    kind: choice(['document', 'template', 'section'], 'kind is document, template or section.').optional(),
    docType: docText(DOC_TYPE_TEXT, 40).refine((v) => listTypes().includes(v), DOC_TYPE_TEXT).optional(),
    visibility: choice(['private', 'team'], 'visibility is private or team.').optional(),
    // Empty means "the root folder", as the library sends it.
    folderId: docText('folderId is the id of a folder, or empty for the root.', 200).optional(),
    category: docText('category is text.', 200).optional(),
    sort: choice(['updated', 'name'], 'sort is updated or name.').optional(),
};
const ListQuery = queryOf({
    ...listFilters, ...pageOf('At most 200 are listed.'),
    archived: choice(['0', '1'], 'archived is 1 for your archived documents.').optional(),
}, 'The document list');
const TemplatesQuery = queryOf({ ...listFilters, limit: pageOf('At most 200 are listed.').limit }, 'The template list');
const StartersQuery = queryOf({ locale: docText('locale is a language code, like en or nl.', 20).optional() }, 'The starters');
const VersionQuery = queryOf({ versionId: docText('versionId is the id of a revision.', 200).optional() }, 'This document');
const PreviewQuery = queryOf({ edit: choice(['0', '1'], 'edit is 1 for the editing bridge.').optional() }, 'The preview');
const valuesMap = (name) => z.record(z.unknown(), { invalid_type_error: `${name} is an object of values.` });
const REVISION_TEXT = 'expectedVersionId is the revision you read.';
const bodies = {
    deckTemplate: bodyOf({ dataUrl: docText('Send the deck as a base64 data URL.', 40_000_000), name: docText('name is text.', 500).optional() }, 'A template deck'),
    folder: bodyOf({ name: docText('A folder needs a name.', 200), parentId: anId('parentId').nullish() }, 'A folder'),
    reviewUpdate: bodyOf({ sectionId: docText('sectionId is the id of a section.', 200).nullish() }, 'Reviewing an update'),
    previewChanges: bodyOf({ deck: valuesMap('deck').nullish(), design: valuesMap('design').nullish() }, 'Previewing a design'),
    aiProposal: bodyOf({
        message: docText('Describe the requested change', 12_000),
        mode: choice(['design', 'content', 'applicability'], 'mode is design, content or applicability.').optional(),
        values: valuesMap('values').nullish(),
        history: z.array(z.object({ role: docText('role is user or assistant.', 20), content: z.unknown() }).passthrough(), { invalid_type_error: 'history is the list of earlier turns.' }).optional(),
    }, 'A change request'),
    check: bodyOf({ values: valuesMap('values').nullish(), sectionOverrides: valuesMap('sectionOverrides').nullish() }, 'Validating a document'),
    duplicate: bodyOf({
        name: docText('name is text of at most 200 characters.', 200).optional(),
        kind: choice(['document', 'template', 'section'], 'kind is document, template or section.').optional(),
    }, 'Copying a document'),
    insertSection: bodyOf({ sourceId: anId('sourceId'), expectedVersionId: docText(REVISION_TEXT, 200).optional() }, 'Inserting a section'),
    deckDraft: bodyOf({ bodyHtml: worded('bodyHtml is the outline, as text.').optional(), settings: valuesMap('settings').nullish() }, 'A presentation draft'),
    restore: bodyOf({ expectedVersionId: docText(REVISION_TEXT, 200).optional() }, 'Restoring a revision'),
};

// The preview is loaded into a sandboxed iframe on the app's own origin. These
// headers are the belt to that braces: even if something executable survived
// the sanitiser, it has no origin to reach and nowhere to send anything.
const PREVIEW_CSP = [
    "default-src 'none'",
    "img-src data:",
    "font-src data:",
    // 'unsafe-inline' covers the <style> blocks and the edit bridge, both of
    // which we emit ourselves; no external script can load at all.
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "form-action 'none'",
    "frame-ancestors 'self'",
].join('; ');

/** Turn a document name into something safe for a Content-Disposition filename. */
function pdfFilename(name, extension = 'pdf') {
    const base = String(name || 'document')
        .normalize('NFKD')
        .replace(/[^\w\s.-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80) || 'document';
    return `${base}.${extension}`;
}

/**
 * The HTML a document shows on screen: the composed page, or for a
 * presentation the slide viewer — the outline as written (tokens and all)
 * unless `values` fills it. `draft` previews unsaved edits without storing.
 */
async function previewHtmlFor(req, doc, { mode = 'print', values = null, sectionOverrides = {}, draft = null } = {}) {
    if (isDeckDocument(doc)) {
        const out = await renderDeckDocument({
            document: doc, values, sectionOverrides, draft, format: 'html', orgId: orgIdOf(req),
            resolveImage: imageResolverFor(req, doc), assertFilled: false,
        });
        return out.html;
    }
    return composeDocument(forCompose(doc), { mode, houseStyleCss: await houseStyleCssFor(req, doc) });
}

/**
 * How a render of `doc` reads its stored pictures for this reader: their own,
 * and a colleague's that the colleague put into this document themselves (a
 * deck filed into a project; core/documents/documentImages.js).
 */
function imageResolverFor(req, doc) {
    const { makeUserImageResolver } = require('../services/presentationRenderer');
    const { makeDocumentImageResolver, sharedAuthorCache } = require('../core/documents/documentImages');
    return makeDocumentImageResolver({
        readerId: req.session.user.id, doc, resolverFor: makeUserImageResolver, cache: sharedAuthorCache(),
        firstAuthorOf: (documentId, needles, opts) => documentStore.firstAuthorOf(documentId, needles, opts),
        revisionSeqOf: (documentId) => documentStore.revisionSeqOf(documentId),
    });
}

/**
 * A project member who may read this document but not change it: answer 403
 * with a sentence, before the write the store would refuse anyway. Only for a
 * project viewer; every other reader keeps the answers they always had.
 */
function refuseReadOnly(res, doc) {
    if (doc?.projectRole !== 'viewer' && doc?.sharingRole !== 'viewer') return false;
    res.status(403).json({ error: 'You can read this document, but only its editors can change it.', code: 'document_read_only' });
    return true;
}

function sendStoreError(res, err, fallback) {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.errorClass || (typeof err.code === 'string' ? err.code : undefined), details: err.details, issues: err.issues, conflict: err.conflict });
    log.error(`[StudioDocuments] ${fallback}:`, err && err.message);
    return res.status(500).json({ error: fallback });
}

/**
 * Which organisation's letterhead applies to this caller.
 *
 * A house style is a company's, not a person's, so it hangs off the org. A user
 * with no org (a single-user self-host) simply has none, and every document
 * they make is whatever its own stylesheet says.
 */
function orgIdOf(req) {
    return req.session.connectorOrgId || req.session.user.organizationId || null;
}

/**
 * The CSS layer to inject for one document, or ''.
 *
 * The rule itself lives in core/documents/renderFilledDocument.js, which is
 * also what the automation step and the app action render through — so the
 * editor preview, the download here and the PDF an automation mails out can never
 * disagree about whether a document is wearing the letterhead.
 */
function houseStyleCssFor(req, doc) {
    return houseStyleCssForDocument(doc, orgIdOf(req));
}

// ── House style ──────────────────────────────────────────────────────
//
// MOUNTED BEFORE '/:id' ON PURPOSE. Express matches in order, so with these
// below it a GET /house-style would be read as a document whose id is
// "house-style" and answer 404.

router.get('/house-style', requireAuth, async (req, res) => {
    try {
        const orgId = orgIdOf(req);
        // `editable` lets the client show the form read-only rather than
        // offering a Save that will 403. It is the SAME question the PUT below
        // asks, answered here so the UI does not have to guess — but the PUT
        // still asks it for itself, because a client-side flag is a courtesy,
        // not a gate.
        const editable = !!orgId
            && await hasPermission(req.session.user.id, 'org_admin', req.session);
        res.json({
            style: orgId ? await houseStyle.getHouseStyle(orgId) : { ...houseStyle.DEFAULT_STYLE },
            hasOrg: !!orgId,
            editable,
            fonts: Object.keys(houseStyle.FONT_STACKS),
            maxLogoBytes: houseStyle.MAX_LOGO_BYTES,
            logoTypes: houseStyle.LOGO_MIME,
            // What the Presentations section of the editor offers: presets,
            // deck typefaces, cover/table styles, logo placements.
            deck: houseStyle.deckOptionCatalog(),
        });
    } catch (err) {
        sendStoreError(res, err, 'Failed to load the house style');
    }
});

/**
 * The RESOLVED deck theme for a style that may not be saved yet — what the
 * editor's live preview draws while a person is still choosing. Resolution
 * (presets, contrast, derived colours) stays in one place on the server
 * rather than being ported to the client; the answer is data, so any signed-in
 * user may ask. Nothing is stored.
 */
router.post('/house-style/preview-theme', requireAuth, async (req, res) => {
    try {
        const style = houseStyle.normaliseStyle(req.body && req.body.style ? req.body.style : req.body || {});
        res.json({ theme: houseStyle.houseStyleDeckTheme(style, req.body && req.body.overrides ? req.body.overrides : null) });
    } catch (err) {
        sendStoreError(res, err, 'Failed to resolve the deck theme');
    }
});

/**
 * A template deck (.pptx) → the look the deck engine can paint under its
 * own slides (core/documents/pptxTemplate.js). Nothing is stored here: the
 * editor puts the result under `deck.template` and saves it with the style.
 */
// Any signed-in user may READ a template: the result is data the caller
// stores on its own document (settings.deck.template) or, as an org admin,
// on the house style — the PUT below is where the admin gate lives.
router.post('/house-style/deck-template', requireAuth, validate({ body: bodies.deckTemplate }), async (req, res) => {
    try {
        const raw = String((req.body && req.body.dataUrl) || '');
        const m = /^data:[a-z0-9.+/-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
        if (!m) return res.status(400).json({ error: 'Send the deck as a base64 data URL.', code: 'template_invalid' });
        const { extractDeckTemplate, MAX_TEMPLATE_BYTES } = require('../core/documents/pptxTemplate');
        const bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
        if (bytes.length > MAX_TEMPLATE_BYTES) return res.status(413).json({ error: `A template deck may be at most ${MAX_TEMPLATE_BYTES / 1048576} MB.`, code: 'template_too_large' });
        const template = await extractDeckTemplate(bytes, { name: String((req.body && req.body.name) || '') });
        res.json({ template });
    } catch (err) {
        const status = err && err.errorClass === 'template_too_large' ? 413 : (err && /^template_/.test(err.errorClass || '') ? 422 : 500);
        // Only the template's own refusals are worded for the caller; anything
        // else is an internal failure whose text stays in the log.
        if (status === 500) {
            log.error('[StudioDocuments] deck template failed:', err && err.message);
            return res.status(500).json({ error: 'The template deck could not be read.', code: 'template_failed' });
        }
        res.status(status).json({ error: err.message, code: err.errorClass || 'template_failed' });
    }
});

router.put('/house-style', requireAuth, requirePermission('org_admin'), async (req, res) => {
    try {
        const orgId = orgIdOf(req);
        if (!orgId) {
            return res.status(400).json({
                error: 'A house style belongs to an organisation, and this account is not in one.',
                code: 'no_org',
            });
        }
        const style = await houseStyle.setHouseStyle(orgId, req.body || {});
        res.json({ style });
    } catch (err) {
        sendStoreError(res, err, 'Failed to save the house style');
    }
});

// ── Templates ────────────────────────────────────────────────────────
//
// ALSO MOUNTED BEFORE '/:id' (see the note above /house-style): below it,
// GET /templates reads as a document whose id is "templates".

/**
 * The caller's documents WITH their placeholders — what an automation step's
 * document picker and an app action's inspector list, and what both AI
 * builders read so they bind the names a template actually has.
 */
router.get('/templates', requireAuth, validate({ query: TemplatesQuery }), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const templates = await documentStore.listTemplates(req.session.user.id, { ...req.query, limit });
        res.json({ templates });
    } catch (err) {
        sendStoreError(res, err, 'Failed to list document templates');
    }
});

// ── List / create ────────────────────────────────────────────────────

router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const { archived, ...filters } = req.query;
        // A notebook is a document type, listed for whoever may open notebooks.
        const notebooks = await notebookLibraryRouter.notebooksVisible(req);
        const spreadsheets = await sheetRouter.sheetsVisible(req);
        const { documents, total } = await documentStore.listDocumentsPage(req.session.user.id, { ...filters, archived: archived === '1', limit, offset, includeNotebooks: notebooks });
        // Owner and last editor are shown by name; the reader's organisation only.
        const people = await describePeople(documents.flatMap(d => [d.userId, d.updatedBy]), orgIdOf(req));
        res.json({ documents, total, people, notebooks, spreadsheets });
    } catch (err) {
        sendStoreError(res, err, 'Failed to list documents');
    }
});

router.post('/', requireAuth, async (req, res) => {
    try {
        const { name, docType, description, bodyHtml, css, settings, kind, visibility, folderId, categories, starterId, locale } = req.body || {};
        const starter = starterId ? require('../core/documents/documentStarters').starters(locale).find(x => x.id === starterId) : null;
        const doc = await documentStore.createDocument({
            ...starter,
            userId: req.session.user.id,
            name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : starter?.name,
            docType: docType || starter?.docType, description: description || starter?.description,
            bodyHtml: bodyHtml ?? starter?.bodyHtml, css: css ?? starter?.css,
            settings: settings || starter?.settings, kind: kind || starter?.kind, visibility, folderId, categories,
        });
        res.status(201).json({ document: doc });
    } catch (err) {
        sendStoreError(res, err, 'Failed to create document');
    }
});

// Library routes precede /:id so literal names are never treated as document IDs.
router.get('/starters', requireAuth, validate({ query: StartersQuery }), (req, res) => res.json({ starters: require('../core/documents/documentStarters').starters(req.query.locale) }));
router.get('/folders', requireAuth, async (req, res) => {
    try { res.json({ folders: await documentStore.listFolders(req.session.user.id) }); }
    catch (e) { sendStoreError(res,e,'Failed to load folders'); }
});
router.post('/folders', requireAuth, validate({ body: bodies.folder }), async (req, res) => {
    try { res.status(201).json({ folder: await documentStore.createFolder(req.session.user.id,req.body?.name,req.body?.parentId) }); }
    catch (e) { sendStoreError(res,e,'Failed to create folder'); }
});
router.delete('/folders/:folderId', requireAuth, async (req,res) => {
    try { await documentStore.deleteFolder(req.session.user.id,req.params.folderId); res.json({ ok:true }); }
    catch (e) { sendStoreError(res,e,'Failed to delete folder'); }
});
router.get('/:id/contract', requireAuth, validate({ query: VersionQuery }), async (req,res) => {
    try {
        const doc = req.query.versionId ? await documentStore.getDocumentVersion(req.params.id,req.session.user.id,req.query.versionId === 'baseline' ? undefined : req.query.versionId) : await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({ error:'Document not found' });
        res.json({ contract:getContract(doc) });
    } catch(e) { sendStoreError(res,e,'Failed to read contract'); }
});
router.get('/:id/sections/:sectionId', requireAuth, async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({ error:'Document not found' });
        const section = getContract(doc).sections.find(x => x.id === req.params.sectionId);
        if (!section) return res.status(404).json({ error:'Section not found' });
        const $ = require('cheerio').load(doc.bodyHtml,{ xmlMode:true },false);
        res.json({ section, bodyHtml: $(`[data-doc-section="${section.id}"]`).html() });
    } catch(e) { sendStoreError(res,e,'Failed to read section'); }
});
router.get('/:id/updates', requireAuth, async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({error:'Document not found'});
        const refs = [...getContract(doc).sections.filter(s=>s.source).map(s=>({...s.source,sectionId:s.id})),...(doc.settings.source?[doc.settings.source]:[])];
        const updates=[];
        for (const ref of refs) {
            const source=await documentStore.getDocument(ref.documentId,req.session.user.id);
            if(source && !source.archived && source.versionId!==ref.versionId) updates.push({...ref,name:source.name,versionId:source.versionId});
        }
        res.json({updates});
    }catch(e){sendStoreError(res,e,'Could not check updates');}
});
router.post('/:id/review-update', requireAuth, validate({ body: bodies.reviewUpdate }), async(req,res)=>{
    try {
        const doc=await documentStore.getDocument(req.params.id,req.session.user.id);
        if(!doc) return res.status(404).json({error:'Document not found'});
        const section=getContract(doc).sections.find(s=>s.id===req.body?.sectionId);
        const ref=section?.source || (!req.body?.sectionId && doc.settings.source);
        if(!ref) return res.status(404).json({error:'Source not found'});
        const source=await documentStore.getDocument(ref.documentId,req.session.user.id);
        if(!source || source.archived) return res.status(404).json({error:'Source not available'});
        let patch;
        if(section) {
            patch = insertSection(doc, source, section.id, { replace: true });
        } else patch={bodyHtml:source.bodyHtml,css:source.css,settings:{...source.settings,
            sampleValues:doc.settings.sampleValues,sectionOverrides:doc.settings.sectionOverrides,
            source:{documentId:source.id,versionId:source.versionId},resolvedHouseStyleCss:await houseStyleCssFor(req,source)}};
        const next={...doc,...patch};
        res.json({patch,expectedVersionId:doc.versionId,explanation:`Review updated content from ${source.name}. Existing content will be replaced only when you apply.`,
            html:await previewHtmlFor(req,next),
            validation:prepareDocument(next,next.settings.sampleValues || {},next.settings.sectionOverrides || {})});
    }catch(e){sendStoreError(res,e,'Could not prepare update');}
});
router.post('/:id/preview-changes',requireAuth,validate({ body: bodies.previewChanges }),async(req,res)=>{
    try {
        const doc=await documentStore.getDocument(req.params.id,req.session.user.id);
        if(!doc)return res.status(404).json({error:'Document not found'});
        const patch=isDeckDocument(doc) ? {settings:{...doc.settings,deck:req.body?.deck || req.body?.design || {}}} : {settings:{...doc.settings,design:req.body?.design || {}}};
        const proposed={...doc,...patch};
        res.json({patch,expectedVersionId:doc.versionId,explanation:'Review design changes',html:await previewHtmlFor(req,proposed)});
    }catch(e){sendStoreError(res,e,'Could not preview changes');}
});
router.post('/:id/sections/:sectionId/save',requireAuth,async(req,res)=>{
    try {
        const doc=await documentStore.getDocument(req.params.id,req.session.user.id);
        if(!doc)return res.status(404).json({error:'Document not found'});
        const document = await documentStore.createDocument({
            ...extractSection(doc, req.params.sectionId), userId: req.session.user.id,
        });
        res.status(201).json({document});
    }catch(e){sendStoreError(res,e,'Could not save reusable section');}
});
router.post('/:id/ai-proposal', requireAuth, require('express-rate-limit').rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false}), validate({ body: bodies.aiProposal }), async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({error:'Document not found'});
        const limit = await require('../core/entitlements/limits').checkSubscriptionLimits(orgIdOf(req),'chat',req.session.user.id);
        if (limit) return res.status(402).json({error:limit});
        if (!String(req.body?.message || '').trim()) return res.status(400).json({error:'Describe the requested change'});
        const proposal = await require('../core/documents/documentAssistant').propose(doc,{
            message:String(req.body.message).slice(0,12000),values:req.body.values,history:Array.isArray(req.body.history)?req.body.history.slice(-8).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content || '').slice(0,4000)})):[],mode:['design','content','applicability'].includes(req.body.mode) ? req.body.mode : 'design',
            userId:req.session.user.id,orgId:orgIdOf(req) });
        const proposed = {...doc,...proposal.patch};
        res.json({...proposal,html:await previewHtmlFor(req,proposed)});
    } catch(e) { sendStoreError(res,e,'Could not prepare document changes'); }
});
router.post('/:id/validate', requireAuth, validate({ body: bodies.check }), async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({ error:'Document not found' });
        const values = req.body?.values || doc.settings.sampleValues || {};
        const sectionOverrides = req.body?.sectionOverrides || doc.settings.sectionOverrides || {};
        const fill = prepareDocument(doc,values,sectionOverrides);
        const html = isDeckDocument(doc) ? await previewHtmlFor(req,doc,{ values, sectionOverrides }) : composeDocument({ ...doc, bodyHtml:fill.bodyHtml },{ mode:'print', houseStyleCss:await houseStyleCssFor(req,doc) });
        res.json({ ...fill, html });
    } catch(e) { sendStoreError(res,e,'Failed to validate document'); }
});
router.post('/:id/duplicate', requireAuth, validate({ body: bodies.duplicate }), async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        if (!doc) return res.status(404).json({ error:'Document not found' });
        if (doc.docType === 'spreadsheet') return await sheetRouter.duplicateSheet(req, res, doc);
        const kind = req.body?.kind || 'document';
        const settings = { ...doc.settings, source: { documentId:doc.id,versionId:doc.versionId },
            resolvedHouseStyleCss:await houseStyleCssFor(req,doc) };
        delete settings.sampleValues; delete settings.sectionOverrides;
        // A copy is the caller's own private library document, built from an
        // allow-list and never filed into the source's project: reading a
        // project document (a viewer too) must not add content to the project,
        // and a template or section cannot be filed there at all. Someone
        // else's library filing (categories) stays theirs.
        res.status(201).json({ document:await documentStore.createDocument({
            userId:req.session.user.id, name:req.body?.name || `${doc.name} — copy`, kind, visibility:'private', folderId:null,
            docType:doc.docType, description:doc.description, bodyHtml:doc.bodyHtml, css:doc.css, settings,
            categories: doc.projectRole ? [] : doc.categories }) });
    } catch(e) { sendStoreError(res,e,'Failed to copy document'); }
});
router.post('/:id/insert-section', requireAuth, validate({ body: bodies.insertSection }), async (req,res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id,req.session.user.id);
        const source = await documentStore.getDocument(req.body?.sourceId,req.session.user.id);
        if (!doc || !source || source.kind !== 'section') return res.status(404).json({ error:'Document or reusable section not found' });
        if (refuseReadOnly(res, doc)) return;
        if (!req.body?.expectedVersionId) return res.status(428).json({error:'Read the document revision before inserting content.',code:'document_revision_required'});
        const id = 'section-' + require('crypto').randomUUID();
        if (source.archived) return res.status(404).json({ error:'Reusable section is archived' });
        const patch = insertSection(doc, source, id);
        const context = { userId:req.session.user.id,isAdmin:await hasPermission(req.session.user.id,'org_admin',req.session) };
        const updated = await documentStore.updateDocument(doc.id,context,{ ...patch,
            expectedVersionId:req.body?.expectedVersionId, summary:'Inserted reusable section' });
        if (!updated) return res.status(404).json({ error:'Document is read-only' });
        res.json({document:updated});
    } catch(e) { sendStoreError(res,e,'Failed to insert section'); }
});

// ── Read / update / delete ───────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const doc = await documentStore.getDocument(req.params.id, userId);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        // Archiving is the owner's (or an org admin's, for a team template or
        // section); editing is also open to a project's editors and owner.
        const deletable = doc.userId === userId || (doc.visibility === 'team' && await hasPermission(userId, 'org_admin', req.session));
        const managed = await require('../stores/document/solutionTemplates').managedOf(doc.id);
        const editable = !managed && (deletable || doc.projectRole === 'editor' || doc.projectRole === 'owner' || doc.sharingRole === 'editor');
        const people = await describePeople([doc.userId, doc.updatedBy], orgIdOf(req));
        res.json({ document: { ...doc, editable, deletable: deletable && !managed, managed, contract: getContract(doc) }, people });
    } catch (err) {
        sendStoreError(res, err, 'Failed to load document');
    }
});

// What a client may not decide about the revision it writes: the routes and
// tools say where a version came from and who made it.
const INTERNAL_KEYS = Object.freeze(['source', 'contributors', 'restoredFrom', 'mergeWith', 'merge']);

router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await documentStore.getDocument(req.params.id, userId);
        if (!existing) return res.status(404).json({ error: 'Document not found' });
        if (refuseReadOnly(res, existing)) return;
        if (!req.body?.expectedVersionId) return res.status(428).json({error:'Read the document revision before saving changes.',code:'document_revision_required'});
        const body = { ...(req.body || {}) };
        const wantsMerge = body.merge === true;
        for (const key of INTERNAL_KEYS) delete body[key];
        const context = { userId, isAdmin: await hasPermission(userId, 'org_admin', req.session) };
        // The page is edited live (checked here, or found by the store's own
        // write, when it went live since): its body is the live state's. The
        // text is kept as a 'conflict' version the page offers once joined.
        const refuseLive = async () => {
            let conflictVersionId = null;
            try { conflictVersionId = await documentStore.keepConflictCopy(req.params.id, context, body.bodyHtml); }
            catch (e) { log.warn('[StudioDocuments] could not keep a refused page body as a version', { documentId: req.params.id, error: e.message }); }
            return res.status(409).json({ error: 'This page is being edited live. Join in to keep editing; your text was kept in its version history.', code: 'document_live', conflictVersionId });
        };
        if (typeof body.bodyHtml === 'string' && await documentFeed.liveCollabFor(existing)) return refuseLive();

        let updated;
        try {
            updated = await documentStore.updateDocument(req.params.id, context, {
                ...body, source: 'autosave', ...(wantsMerge ? { mergeWith: mergeBodies } : {}),
            });
        } catch (err) {
            if (err?.errorClass === 'document_live' && typeof body.bodyHtml === 'string') return refuseLive();
            throw err;
        }
        if (!updated) return res.status(404).json({ error: 'Document not found or read-only' });
        if (updated.versionId !== existing.versionId) {
            await documentFeed.recordContentChange(updated, {
                actorId: userId, source: 'autosave', versionId: updated.versionId, stats: wordStats(existing.bodyHtml, updated.bodyHtml),
            });
            if (updated.name !== existing.name) await documentFeed.recordRenamed(updated, userId);
        }
        res.json({ document: { ...updated, contract: getContract(updated) } });
    } catch (err) {
        sendStoreError(res, err, 'Failed to update document');
    }
});

/** Back from the archive. The owner (an org admin for a team template or section). */
router.post('/:id/unarchive', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ok = await documentStore.unarchiveDocument(req.params.id, { userId, isAdmin: await hasPermission(userId, 'org_admin', req.session) });
        if (!ok) return res.status(404).json({ error: 'Document not found' });
        const document = await documentStore.getDocument(req.params.id, userId);
        res.json({ document });
    } catch (err) {
        sendStoreError(res, err, 'Failed to restore the document');
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // A co-edited project page is folded back into its own row first: once
        // archived it is no longer project content, and edits still only in
        // the co-editing state would not be written back.
        await require('../core/projectContent/itemLifecycle').beforeDelete('document', req.params.id, userId);
        const ok = await documentStore.deleteDocument(req.params.id, { userId, isAdmin: await hasPermission(userId, 'org_admin', req.session) });
        if (!ok) {
            // A project member reading a colleague's document may not archive
            // it; say so rather than pretend it does not exist.
            const readable = await documentStore.getDocument(req.params.id, userId);
            if (readable?.projectRole) {
                return res.status(403).json({ error: 'Only the owner of this document can delete it. The project owner can remove it from the project.', code: 'document_owner_only' });
            }
            return res.status(404).json({ error: 'Document not found' });
        }
        // Its open suggestions are of no use to anybody now (restoring from the archive starts without them).
        try { await require('../stores/documentSuggestionStore').deleteForTarget('document', req.params.id); }
        catch (err) { log.warn(`[Documents] suggestions of document ${req.params.id} not dropped: ${err.message}`); }
        // A task that linked this document keeps existing; the link goes (in every project).
        try { await require('../stores/projectTaskStore').dropLinksTo(null, 'document', req.params.id); }
        catch (err) { log.warn(`[Documents] task links to document ${req.params.id} not dropped: ${err.message}`); }
        res.json({ success: true });
    } catch (err) {
        sendStoreError(res, err, 'Failed to delete document');
    }
});

// ── Composed output ──────────────────────────────────────────────────

function sendPreview(res, html) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Security-Policy', PREVIEW_CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.send(html);
}

router.get('/:id/preview', requireAuth, validate({ query: PreviewQuery }), async (req, res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id, req.session.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        // `edit=1` asks for the hand-editing bridge. The bytes are identical
        // otherwise, so a reader never carries the editor's script. A
        // presentation has no bridge: its outline is edited as text.
        const mode = req.query.edit === '1' ? 'preview' : 'print';
        sendPreview(res, await previewHtmlFor(req, doc, { mode }));
    } catch (err) {
        if (err && err.errorClass === 'document_empty') return sendPreview(res, emptyDeckHtml());
        sendStoreError(res, err, 'Failed to render document');
    }
});

/**
 * A presentation as it WOULD look with the outline and/or look in the body —
 * what the editor draws while a person is still typing or choosing, before
 * anything is saved. Nothing is stored; the same CSP as the saved preview.
 */
router.post('/:id/preview', requireAuth, validate({ body: bodies.deckDraft }), async (req, res) => {
    try {
        const doc = await documentStore.getDocument(req.params.id, req.session.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        if (!isDeckDocument(doc)) return res.status(400).json({ error: 'Only a presentation can be previewed from a draft.', code: 'document_not_deck' });
        const draft = {};
        if (typeof req.body?.bodyHtml === 'string') draft.bodyHtml = req.body.bodyHtml.slice(0, documentStore.MAX_HTML_BYTES);
        if (req.body?.settings && typeof req.body.settings === 'object') draft.settings = req.body.settings;
        sendPreview(res, await previewHtmlFor(req, doc, { draft }));
    } catch (err) {
        if (err && err.errorClass === 'document_empty') return sendPreview(res, emptyDeckHtml());
        if (err && /^deck_/.test(err.errorClass || '')) return res.status(422).json({ error: err.message, code: err.errorClass });
        sendStoreError(res, err, 'Failed to render the presentation');
    }
});

/** What the viewer shows for a presentation without slides yet. */
function emptyDeckHtml() {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Presentation</title><style>html{background:#23262b}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,sans-serif;color:rgba(255,255,255,.6)}</style></head>'
        + '<body><p data-deck-empty="1">No slides yet — write the outline: one "## " heading per slide.</p></body></html>';
}

/**
 * A presentation as a real PowerPoint file. The PDF route below serves the
 * same deck on paper; both go through renderFilledDocument, as an automation's
 * fill_document does, so the download and the run cannot disagree.
 */
router.get('/:id/pptx', requireAuth, validate({ query: VersionQuery }), async (req, res) => {
    try {
        const doc = req.query.versionId
            ? await documentStore.getDocumentVersion(req.params.id, req.session.user.id, req.query.versionId)
            : await documentStore.getDocument(req.params.id, req.session.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        if (!isDeckDocument(doc)) return res.status(400).json({ error: 'Only a presentation can be downloaded as .pptx.', code: 'document_not_deck' });
        if (!doc.bodyHtml || !doc.bodyHtml.trim()) return res.status(400).json({ error: 'This presentation has no slides yet.', code: 'document_empty' });
        const marking = await markingFor(req);
        const { renderFilledDocument } = require('../core/documents/renderFilledDocument');
        const out = await renderFilledDocument({ document: doc, values: doc.settings.sampleValues || {},
            sectionOverrides: doc.settings.sectionOverrides || {}, orgId: orgIdOf(req), marking, format: 'pptx',
            resolveImage: imageResolverFor(req, doc) });
        res.set('Content-Type', out.contentType);
        res.set('Content-Disposition', `attachment; filename="${pdfFilename(doc.name, 'pptx')}"`);
        res.send(out.buffer);
    } catch (err) {
        if (err && err.errorClass) return res.status(err.status || 400).json({ error: err.message, code: err.errorClass, issues: err.issues });
        sendStoreError(res, err, 'Failed to build the presentation');
    }
});

/** AI Act Art. 50(2) marking for a download, or null when the org marks nothing. */
async function markingFor(req) {
    try {
        const { resolveMarking } = require('../compliance/marking');
        const orgId = req.session.connectorOrgId || req.session.user.organizationId || null;
        return orgId ? await resolveMarking(orgId, { provider: 'document' }) : null;
    } catch (e) {
        log.warn('[StudioDocuments] Marking lookup failed, rendering unmarked:', e.message);
        return null;
    }
}

router.get('/:id/pdf', requireAuth, validate({ query: VersionQuery }), async (req, res) => {
    try {
        const doc = req.query.versionId
            ? await documentStore.getDocumentVersion(req.params.id, req.session.user.id, req.query.versionId)
            : await documentStore.getDocument(req.params.id, req.session.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        if (!doc.bodyHtml || !doc.bodyHtml.trim()) {
            return res.status(400).json({ error: 'This document is still empty.', code: 'document_empty' });
        }

        // AI Act Art. 50(2): a document built from model output carries the
        // visible line and the PDF metadata when the org has marking on.
        // resolveMarking answers null when it is off, and the renderer then
        // stamps nothing — so this is one call, not a branch.
        let marking = null;
        try {
            const { resolveMarking } = require('../compliance/marking');
            const orgId = req.session.connectorOrgId || req.session.user.organizationId || null;
            if (orgId) marking = await resolveMarking(orgId, { provider: 'document' });
        } catch (e) {
            log.warn('[StudioDocuments] Marking lookup failed, rendering unmarked:', e.message);
        }

        const { renderFilledDocument } = require('../core/documents/renderFilledDocument');
        const out = await renderFilledDocument({ document: doc, values: doc.settings.sampleValues || {},
            sectionOverrides: doc.settings.sectionOverrides || {}, orgId: orgIdOf(req), marking, format: 'pdf',
            resolveImage: imageResolverFor(req, doc) });

        res.set('Content-Type', out.contentType);
        res.set('Content-Disposition', `attachment; filename="${pdfFilename(doc.name)}"`);
        if (out.degraded) res.set('X-Document-Degraded', '1');
        res.send(out.buffer);
    } catch (err) {
        if (err && err.errorClass) {
            return res.status(err.status || 400).json({ error: err.message, code: err.errorClass, issues: err.issues });
        }
        sendStoreError(res, err, 'Failed to render PDF');
    }
});

// ── Versions and presence ───────────────────────────────────────────
//
// Their own factory routers; mounted here so they share this router's
// place under /api/studio-documents.

router.use('/:id/versions', require('./studioDocuments/versions'));
router.use('/', require('./studioDocuments/presence'));
router.use('/', require('./studioDocuments/stream'));
router.use('/', notebookLibraryRouter);
router.use('/', sheetRouter);

module.exports = router;
