/**
 * Notebook Routes — CRUD for notebooks, the in-notebook chat history, editor
 * images and file import.
 *
 * Endpoints:
 *   POST   /                    — create notebook
 *   GET    /                    — list user's notebooks
 *   GET    /:id                 — get notebook detail
 *   GET    /:id/conversation    — the persisted in-notebook chat
 *   DELETE /:id/conversation    — clear it
 *   PUT    /:id                 — update notebook
 *   DELETE /:id                 — delete notebook
 *   POST   /:id/images          — editor image upload
 *   POST   /:id/import-file     — parse a file into the editor
 *
 * Sources (/:id/sources…) live in routes/notebooksSources.js, Studio
 * generation and AI Fill (/:id/generate/:type, /:id/ai-fill) in
 * routes/notebooksGenerate.js; both are mounted below at the place their routes
 * always had in this table. Versions (the uniform version API) live in
 * routes/notebooksVersions.js, mounted last. The role gates, `seams`, the upload
 * and the schema parts they share are in routes/notebooksShared.js.
 *
 * Every `/:id…` route starts with requireNotebookRole (routes/notebooksAccess.js):
 * viewers read, editors change the document and its sources, the notebook's
 * owner deletes. While a notebook is co-edited (core/collab), the whole-document
 * PUT refuses with 409 COLLAB_ACTIVE: the live document is the co-editing state.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
router.use(require('../stores/lib/documentCrypto').withDocumentEncryptionSession);
const multer = require('multer');
const crypto = require('crypto');

const notebookStore = require('../stores/notebookStore');
const notebookConversationStore = require('../stores/notebookConversationStore');
const storageStore = require('../stores/storageStore');
require('../stores/knowledgeBases');
require('../core/documents/documentParser');
require('../core/kb/kbIngestionHelpers');
const { requirePermission } = require('../auth');
// Shared with routes/knowledgeBases.js — a client naming a kb id must be
// authorized for it before we persist or search it. The KB retrieval layer
// does no tenant filtering of its own; the kb id list IS the access boundary.
const { partitionAccessibleKBIds } = require('../support/kbAccess');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, flag, wholeNumber, typeError } = require('../core/http/schemaParts');
const { HttpError } = require('../core/http/errors');
const notebookCollab = require('../agents/notebooks/notebookCollab');
const { asViewer, asEditor, asOwner, seams, upload, text, ids } = require('./notebooksShared');

/**
 * The project a notebook is filed in, as its page shows it ("In project X"),
 * for a caller who is a member of that project; null otherwise. Never fails
 * the notebook read.
 */
async function projectSummaryFor(nb, userId) {
    if (!nb.projectId) return null;
    try {
        const role = nb.projectRole || await seams.projectRoleOf(userId, nb.projectId);
        if (!role) return null;
        const p = await seams.getProject(nb.projectId);
        if (!p) return null;
        return { id: p.id, name: p.name, kind: p.kind ?? null, color: p.color || null, icon: p.icon || null, role };
    } catch (err) {
        log.warn('[Notebooks] project summary unavailable', { notebookId: nb.id, error: err.message });
        return null;
    }
}

/** Co-editing applies to notebooks in a collaborative workspace (or a legacy, unclassified project). */
function collabEligible(project) {
    return !!project && (project.kind === 'workspace' || project.kind === null);
}

// ── What a caller may send ─────────────────────────────────────────
// Every JSON body and query the routes below read is closed: a misspelled key
// is a 400 naming it, not a 200 that ignored it. The multipart routes
// (sources/file, images, import-file) read the file and nothing else.
// What these close: `expectedVersion: "5"` (text) skipped the version check
// and overwrote a newer document; `pinned: "false"` pinned; `?filter=pinnd`
// listed every notebook; `ids: "s1"` on bulk-delete answered 200 deleted:0;
// a Drive import with `provider: "onedrive"` was filed as Google Drive.
// The schema parts (`text`, `ids`) are in routes/notebooksShared.js.

const ListQuery = queryOf({
    limit: wholeNumber('limit is a whole number.').optional(),
    offset: wholeNumber('offset is a whole number, 0 or more.').optional(),
    // Clamped to 200 characters by the handler, as before.
    search: text('search is text.', 2000).optional(),
    sort: choice(['activity', 'name', 'created', 'words'], 'sort is activity, name, created or words.').optional(),
    filter: choice(['all', 'pinned', 'sources', 'chat', 'empty', 'processing'], 'filter is all, pinned, sources, chat, empty or processing.').optional(),
}, 'The notebook list');

const CreateBody = bodyOf({
    name: text('name is text of at most 500 characters.', 500).optional(),
    description: text('description is text.', 10_000).nullish(),
    instructions: text('instructions is text.', 50_000).nullish(),
}, 'Creating a notebook');

const UpdateBody = bodyOf({
    name: text('name is text of at most 500 characters.', 500).optional(),
    description: text('description is text.', 10_000).nullish(),
    instructions: text('instructions is text.', 50_000).nullish(),
    settings: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'settings is an object.' }) }).nullish(),
    knowledgeBaseIds: ids('knowledgeBaseIds must be an array').optional(),
    documentContent: worded('documentContent is the document, as text.').optional(),
    pinned: flag('pinned is true or false.').optional(),
    expectedVersion: wholeNumber('expectedVersion is the whole-number version you loaded.').nullish(),
}, 'Updating a notebook');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions'); const { bestEffort } = require('../utils/bestEffort');

// Every notebook route requires the `use_notebooks` permission. Ownership
// isolation is still enforced per-route via the user_id check in notebookStore.
router.use(requirePermission('use_notebooks'));

// ── Notebook CRUD ──────────────────────────────────────────────────

router.post('/', requireAuth, validate({ body: CreateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { name, description, instructions } = req.body;
    // Stamped at birth: without it the row stayed org-less until the next
    // boot's backfill, and the cross-tenant checks had nothing to compare.
    const organizationId = req.session.user.organizationId || null;
    const notebook = await notebookStore.createNotebook({ userId, name, description, instructions, organizationId });
    res.json({ success: true, notebook });
});

router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    const userId = req.session.user.id;
    // Paginate. This called getNotebooks(userId) with no options, which fell
    // back to the store's default LIMIT 50 — so a user with more than 50
    // notebooks silently lost access to the older ones (the sidebar never
    // listed them, and the deep-link path resolves ids out of this list).
    // Clamp to the store's cap so hasMore (length === limit) is truthful.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), notebookStore.MAX_CARD_LIMIT);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // Card projection — counts + cached preview, never document bodies.
    // `type` is hardcoded so only plain notebooks appear in this list
    // (or can be cascade-deleted through it). Sort/filter are whitelisted
    // here AND in the store; unknown values fall back to the defaults.
    const search = String(req.query.search || '').trim().slice(0, 200);
    const sort = ['activity', 'name', 'created', 'words'].includes(req.query.sort) ? req.query.sort : 'activity';
    const filter = ['all', 'pinned', 'sources', 'chat', 'empty', 'processing'].includes(req.query.filter) ? req.query.filter : 'all';
    const notebooks = await notebookStore.listNotebookCards(userId, { limit, offset, type: 'notebook', search, sort, filter });
    res.json({ notebooks, limit, offset, hasMore: notebooks.length === limit });
});

router.get('/:id', requireAuth, asViewer, async (req, res) => {
    const userId = req.session.user.id;
    const notebook = req.notebook;

    // Flip any sources that have been "processing" for > 10 min to errored.
    // Protects users from yellow rows stuck forever after a worker crash.
    await notebookStore.timeoutStuckSources(notebook.id).catch((e) => bestEffort('routes/notebooks:anon', e));

    const sources = await notebookStore.getSources(notebook.id);
    const project = await projectSummaryFor(notebook, userId);
    res.json({
        notebook: { ...notebook, role: req.notebookRole },
        sources,
        // "In project X" and whether the page should join a co-editing session.
        project,
        collab: { eligible: collabEligible(project) },
    });
});

// ── In-notebook chat history (persistent, encrypted) ─────────────────────
// Returns the durable conversation for this notebook
// so the chat panel can rehydrate on page load / notebook switch instead of
// starting from an empty React state. Ownership is enforced via getNotebook.
router.get('/:id/conversation', requireAuth, asViewer, async (req, res) => {
    const userId = req.session.user.id;
    const encryptionKey = req.session.encryptionKey || null;
    // `locked` = encrypted history we can't decode with this session's DEK —
    // the UI shows "history unavailable" instead of a silently empty chat.
    const { messages, locked } = await notebookConversationStore.getMessagesWithMeta(req.params.id, userId, encryptionKey);
    // Stored assistant content is TOKENIZED (defense-in-depth inside the
    // encrypted blob); restore `[person_1]` → real values for display, using
    // the notebook's persisted PII token map (hydrated from notebooks.pii_token_map).
    // User messages are stored real, so restore is a no-op for them.
    let outMessages = messages;
    try {
        const dlpRunner = require('../core/dlp/dlpRunner');
        const map = await dlpRunner.getConversationTokenMapAsync(req.params.id);
        if (map && Object.keys(map).length) {
            const { restoreTokens } = require('../core/privacy/piiDetection');
            outMessages = messages.map(m => (typeof m.content === 'string'
                ? { ...m, content: restoreTokens(m.content, map) }
                : m));
        }
    } catch (e) {
        log.warn('[Notebooks] token restore on conversation load failed:', e.message);
    }
    res.json({ messages: outMessages, locked });
});

// Clear the persisted in-notebook conversation ("new chat" in the panel).
router.delete('/:id/conversation', requireAuth, asViewer, async (req, res) => {
    const userId = req.session.user.id;
    await notebookConversationStore.deleteForNotebook(req.params.id, userId);
    // Drop the accumulated PII token map too, so a fresh chat doesn't inherit
    // stale `[person_1]` → value mappings from the cleared conversation.
    // Not for a project notebook: the map is the notebook's, shared by every
    // member's private chat, and one person starting over must not leave
    // the others' histories unreadable.
    if (!req.notebook.projectId) {
        try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (err) { bestEffort('routes/notebooks:anon#2', err); /* best-effort */ }
    }
    res.json({ success: true });
});

/**
 * Keep a whole-document save that could not be applied as a 'conflict'
 * version. Returns its id, or null when there was nothing to keep or it could
 * not be written (logged, ids only).
 */
async function keepConflictCopy(notebookId, userId, documentContent) {
    if (typeof documentContent !== 'string' || !documentContent.trim()) return null;
    try {
        const kept = await notebookStore.recordVersion(notebookId, {
            html: documentContent, source: 'conflict', createdBy: userId,
            contributors: [{ userId, kind: 'user' }],
        });
        return kept.id;
    } catch (err) {
        log.error('[Notebooks] could not keep the conflicting copy as a version', { notebookId, error: err.message });
        return null;
    }
}

router.put('/:id', requireAuth, validate({ body: UpdateBody }), asEditor, async (req, res) => {
    const userId = req.session.user.id;
    const nb = req.notebook;
    const { name, description, instructions, settings, knowledgeBaseIds, documentContent, pinned, expectedVersion } = req.body;

    // The pin orders and filters the OWNER's own library (listNotebookCards);
    // it is one person's, not the project's (mapProjectNotebookCard leaves it
    // out for that reason), so a colleague may neither set nor clear it.
    if (pinned !== undefined && req.notebookRole !== 'owner') {
        throw new HttpError(403, 'notebook_owner_only', 'Only the owner of this notebook can pin it in their library.');
    }

    // While the notebook is co-edited the live document is the co-editing
    // state: a whole-document write here would be overwritten by the next
    // materialisation, or overwrite everyone's typing. The page joins the
    // session instead.
    if (documentContent !== undefined && await notebookCollab.isCollabActive(nb.id, seams.collab())) {
        // The text is not thrown away: it is kept as a 'conflict' version the
        // page can offer once it has joined the live session.
        const conflictVersionId = await keepConflictCopy(nb.id, userId, documentContent);
        throw new HttpError(409, 'COLLAB_ACTIVE', 'This notebook is being edited together right now. Join the live session; your text was kept in the version history.', {
            conflictVersionId,
        });
    }

    // A notebook's knowledgeBaseIds drive retrieval in notebook chat and in
    // /generate/:type, on a search path that deliberately does no tenant
    // filtering of its own. Attaching an arbitrary id here would therefore
    // read another tenant's knowledge base, so authorize every id first.
    // Which bases a notebook reads is its owner's call: an editor detaching the
    // notebook's own base would take every source away from everyone.
    if (knowledgeBaseIds !== undefined) {
        if (req.notebookRole !== 'owner') {
            throw new HttpError(403, 'notebook_owner_only', 'Only the owner of this notebook can change which knowledge bases it uses.');
        }
        const { denied } = await partitionAccessibleKBIds(req, knowledgeBaseIds);
        if (denied.length > 0) {
            log.warn('[Notebooks] refused inaccessible kb ids on update:', { notebookId: req.params.id, userId, denied });
            return res.status(403).json({ error: 'One or more knowledge bases are not accessible' });
        }
    }

    // CAS write: `expectedVersion` (when the client sends one) turns
    // last-writer-wins into an explicit 409 the editor can react to.
    const r = await notebookStore.updateNotebookCas(req.params.id, userId, {
        name, description, instructions, settings, knowledgeBaseIds, documentContent, pinned,
        ...(Number.isFinite(expectedVersion) ? { expectedVersion } : {}),
    });
    if (r.conflict) {
        // Nobody's text is thrown away: the copy that lost the race is kept
        // as a 'conflict' version the page offers to compare and choose from.
        const conflictVersionId = await keepConflictCopy(nb.id, userId, documentContent);
        // A colleague opened it live between the check above and this write.
        if (r.coEdited) {
            throw new HttpError(409, 'COLLAB_ACTIVE', 'This notebook is being edited together right now. Join the live session; your text was kept in the version history.', {
                conflictVersionId,
            });
        }
        throw new HttpError(409, 'version_conflict', 'Document was updated elsewhere', {
            currentVersion: r.currentVersion ?? null,
            conflictVersionId,
        });
    }
    if (r.noop) return res.status(400).json({ error: 'No fields to update' });
    if (!r.ok) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');

    const feed = seams.feed();
    // A version is the state AFTER a checkpoint: at most one automatic one
    // per five minutes, holding what was just saved.
    if (documentContent !== undefined && documentContent.trim()) {
        try {
            if (await notebookStore.shouldAutoVersion(nb.id)) {
                const v = await notebookStore.recordVersion(nb.id, {
                    html: documentContent, source: 'checkpoint', createdBy: userId,
                    contributors: [{ userId, kind: 'user' }],
                });
                if (!v.deduped) {
                    void feed.contentChanged({ projectId: nb.projectId, notebookId: nb.id, contributors: [{ userId, kind: 'user' }], versionId: v.id, source: 'checkpoint' });
                }
            }
        } catch (vErr) {
            log.warn('[Notebooks] Auto-version failed:', vErr.message);
        }
    }
    if (typeof name === 'string' && name !== nb.name) {
        void feed.renamed({ projectId: nb.projectId, notebookId: nb.id, actorId: userId });
    }
    res.json({ success: true, version: r.version });
});

router.delete('/:id', requireAuth, asOwner, async (req, res) => {
    const userId = req.session.user.id;
    // Full cascade: per-source storage blobs and derived chunks/embeddings,
    // then the row (sources + versions cascade via FK), then the KBs this
    // notebook created, then the persisted chat. Deleting only the row left
    // the actual bytes behind — see core/notebookCascade.js.
    const { deleteNotebookCascade } = require('../core/kb/notebookCascade');
    const result = await deleteNotebookCascade(req.params.id, userId);
    if (!result.deleted) return res.status(404).json({ error: 'Notebook not found' });
    log.info(`[Notebooks] deleted ${req.params.id} (${result.sources} sources, ${result.kbs} auto-KBs)`);
    // Drop the in-process PII token map (the row's pii_token_map goes away with
    // the cascading notebook delete; this clears the cached copy + flag).
    try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (err) { bestEffort('routes/notebooks:anon#3', err); /* best-effort */ }

    res.json({ success: true });
});

// ── Sources ─────────────────────────────────────────────────────────
// Everything under /:id/sources — routes/notebooksSources.js.
router.use('/', require('./notebooksSources'));

// ── Studio: Generate Content and AI Fill ────────────────────────────
// /:id/generate/:type and /:id/ai-fill — routes/notebooksGenerate.js.
router.use('/', require('./notebooksGenerate'));

// ── Notebook Image Upload (for TipTap Image extension) ───────────
//
//  POST /api/notebooks/:id/images
//  Accepts: multipart/form-data { image: File }
//  Returns: { url: "/api/storage/file/..." }
//
//  Images are stored in RustFS under users/{userId}/notebook-images/.
//  If RustFS is not configured the server falls back to a base64 data-URL
//  so the editor still works in local dev without object storage.

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
        if (/^image\//.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    },
});

// 'workspace' is a virtual notebook id for the chat's workspace pane: the
// image belongs to the caller alone. Every real notebook needs an editor.
const asEditorUnlessWorkspace = (req, res, next) => (req.params.id === 'workspace' ? next() : asEditor(req, res, next));

router.post('/:id/images', requireAuth, asEditorUnlessWorkspace, imageUpload.single('image'), async (req, res) => {
    const userId = req.session.user.id;
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const { buffer, mimetype, originalname } = req.file;
    const ext = originalname.split('.').pop().toLowerCase();
    const safeFilename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;

    if (storageStore.isAvailable()) {
        // Store in RustFS and return a proxy URL (token-free, routed through Express)
        const key = storageStore.buildKey(userId, 'notebook-images', safeFilename);
        await storageStore.uploadFile(key, buffer, mimetype);
        const url = storageStore.buildProxyUrl(key);
        return res.json({ url });
    }

    // Fallback: base64 data-URL (works in local dev without RustFS)
    const b64 = buffer.toString('base64');
    const url = `data:${mimetype};base64,${b64}`;
    return res.json({ url });

});

// ── Import File to Editor (PDF, DOCX, TXT...) ────────────────────

router.post('/:id/import-file', requireAuth, asEditor, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { parseDocument } = require('../core/documents/documentParser');
    const text = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname, { returnHtml: true });

    res.json({ success: true, text });
});

// ── Versions ────────────────────────────────────────────────────────
// The uniform version API (list with a cursor, one version with content,
// name the current state, rename, restore, delete) — routes/notebooksVersions.js.
router.use('/', require('./notebooksVersions'));

module.exports = router;
module.exports.seams = seams;
