/**
 * Notebook Routes — CRUD for notebooks + source management.
 *
 * Endpoints:
 *   POST   /                    — create notebook
 *   GET    /                    — list user's notebooks
 *   GET    /:id                 — get notebook detail
 *   PUT    /:id                 — update notebook
 *   DELETE /:id                 — delete notebook
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt…)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   DELETE /:id/sources/:sid    — remove source
 *
 * Template-fill endpoints (preserved for backwards compat):
 *   POST   /:id/upload-template — upload .docx template to a notebook
 *   POST   /:id/fill            — fill template with values
 *   POST   /:id/fill-and-store  — fill + store result
 *   GET    /:id/download        — download original template .docx
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');

const notebookStore = require('../stores/notebookStore');
const notebookConversationStore = require('../stores/notebookConversationStore');
const storageStore = require('../stores/storageStore');
const transcriptionStore = require('../stores/transcriptionStore');
require('../stores/knowledgeBases');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource, MAX_STORED_TEXT } = require('../agents/notebooks/sourceIngestion');
const { countWords } = require('../utils/text');
require('../core/documents/documentParser');
require('../core/kb/kbIngestionHelpers');
const { requirePermission } = require('../auth');
// Shared with routes/knowledgeBases.js — a client naming a kb id must be
// authorized for it before we persist or search it. The KB retrieval layer
// does no tenant filtering of its own; the kb id list IS the access boundary.
const { partitionAccessibleKBIds } = require('../support/kbAccess');
// Module scope on purpose: /ai-fill reads TIER_DEFAULTS too, and when this was
// require()'d inside the /generate/:type handler it was block-scoped there, so
// every AI-Fill run threw ReferenceError after the SSE headers had been sent.
const { TIER_DEFAULTS } = require('../core/llm/modelResolver');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, flag, wholeNumber } = require('../core/http/schemaParts');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// Upper bound on a single bulk-delete request. Caps both accidental runaway
// clients and id-enumeration attempts against the scoped delete.
const MAX_BULK_DELETE_IDS = 100;

// Upper bound on a single Drive/OneDrive import. Each file spawns a detached
// ingestion job, so this is the only thing standing between one picker
// selection and an unbounded fan-out.
const MAX_DRIVE_FILES_PER_REQUEST = 25;

// ── What a caller may send ─────────────────────────────────────────
// Every JSON body and query the routes below read is closed: a misspelled key
// is a 400 naming it, not a 200 that ignored it. The multipart routes
// (sources/file, images, import-file) read the file and nothing else.
// What these close: `expectedVersion: "5"` (text) skipped the version check
// and overwrote a newer document; `pinned: "false"` pinned; `?filter=pinnd`
// listed every notebook; `ids: "s1"` on bulk-delete answered 200 deleted:0;
// a Drive import with `provider: "onedrive"` was filed as Google Drive.
const text = (message, max) => worded(message).max(max, message);
const NOTEBOOK_ID_TEXT = 'Every id is a non-empty id of at most 200 characters.';
const ids = (message) => z.array(worded(message).min(1, NOTEBOOK_ID_TEXT).max(200, NOTEBOOK_ID_TEXT), { required_error: message, invalid_type_error: message });
const modelTier = text('modelTier is the name of a model tier.', 100).optional();

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
    settings: z.record(z.unknown(), { invalid_type_error: 'settings is an object.' }).nullish(),
    knowledgeBaseIds: ids('knowledgeBaseIds must be an array').optional(),
    documentContent: worded('documentContent is the document, as text.').optional(),
    pinned: flag('pinned is true or false.').optional(),
    expectedVersion: wholeNumber('expectedVersion is the whole-number version you loaded.').nullish(),
}, 'Updating a notebook');

const UrlBody = bodyOf({ url: text('URL required', 4000).min(1, 'URL required') }, 'Adding a web page');
const TextBody = bodyOf({
    text: worded('Text content required').min(1, 'Text content required'),
    name: text('name is text of at most 500 characters.', 500).optional(),
}, 'Adding text');
const MeetingBody = bodyOf({
    meetingId: text('Meeting ID required', 200).min(1, 'Meeting ID required'),
    mode: choice(['full', 'summary'], 'mode is full or summary.').optional(),
}, 'Adding a meeting');
const DRIVE_FILE_TEXT = 'Each file is { name, driveFileId, content }.';
const DriveBody = bodyOf({
    // Items stay open: the Drive pickers hand over their whole file card
    // (type, size, source …); only the three fields read here are typed.
    files: z.array(z.object({
        name: text('A file name is text.', 1000).optional(),
        driveFileId: text('driveFileId is text.', 500).optional(),
        content: worded('content is the file as text.').optional(),
    }, { invalid_type_error: DRIVE_FILE_TEXT }), { required_error: 'Files array required', invalid_type_error: DRIVE_FILE_TEXT }),
    provider: choice(['google', 'microsoft'], 'provider is google or microsoft.').optional(),
}, 'Importing from Drive');
const ReorderBody = bodyOf({ orderedIds: ids('orderedIds must be an array') }, 'Reordering sources');
const RenameBody = bodyOf({ name: text('Name is required', 2000) }, 'Renaming a source');
const BulkDeleteBody = bodyOf({ ids: ids('ids is a list of source ids.') }, 'Deleting sources');
const GenerateBody = bodyOf({ modelTier }, 'Generating');
const AiFillBody = bodyOf({
    documentContent: worded('No document content provided'),
    modelTier,
}, 'AI fill');
const VersionBody = bodyOf({
    summary: text('summary is text of at most 500 characters.', 500).optional(),
    content: worded('content is the document, as text.').optional(),
}, 'Saving a version');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// Every notebook route requires the `use_notebooks` permission. Ownership
// isolation is still enforced per-route via the user_id check in notebookStore.
router.use(requirePermission('use_notebooks'));

// ── Notebook CRUD ──────────────────────────────────────────────────

router.post('/', requireAuth, validate({ body: CreateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions } = req.body;
        const notebook = await notebookStore.createNotebook({ userId, name, description, instructions });
        res.json({ success: true, notebook });
    } catch (err) {
        log.error('[Notebooks] Create failed:', err);
        res.status(500).json({ error: 'Failed to create notebook' });
    }
});

router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[Notebooks] List failed:', err);
        res.status(500).json({ error: 'Failed to list notebooks' });
    }
});

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });

        // Flip any sources that have been "processing" for > 10 min to errored.
        // Protects users from yellow rows stuck forever after a worker crash.
        await notebookStore.timeoutStuckSources(notebook.id).catch(() => {});

        const sources = await notebookStore.getSources(notebook.id);
        res.json({ notebook, sources });
    } catch (err) {
        log.error('[Notebooks] Get failed:', err);
        res.status(500).json({ error: 'Failed to get notebook' });
    }
});

// ── In-notebook chat history (persistent, encrypted) ─────────────────────
// Returns the durable conversation for this notebook
// so the chat panel can rehydrate on page load / notebook switch instead of
// starting from an empty React state. Ownership is enforced via getNotebook.
router.get('/:id/conversation', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
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
    } catch (err) {
        log.error('[Notebooks] Get conversation failed:', err);
        res.status(500).json({ error: 'Failed to load conversation' });
    }
});

// Clear the persisted in-notebook conversation ("new chat" in the panel).
router.delete('/:id/conversation', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        await notebookConversationStore.deleteForNotebook(req.params.id, userId);
        // Drop the accumulated PII token map too, so a fresh chat doesn't inherit
        // stale `[person_1]` → value mappings from the cleared conversation.
        try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (_) { /* best-effort */ }
        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Clear conversation failed:', err);
        res.status(500).json({ error: 'Failed to clear conversation' });
    }
});

router.put('/:id', requireAuth, validate({ body: UpdateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, instructions, settings, knowledgeBaseIds, documentContent, pinned, expectedVersion } = req.body;

        // A notebook's knowledgeBaseIds drive retrieval in notebook chat and in
        // /generate/:type, on a search path that deliberately does no tenant
        // filtering of its own. Attaching an arbitrary id here would therefore
        // read another tenant's knowledge base, so authorize every id first.
        if (knowledgeBaseIds !== undefined) {
            if (!Array.isArray(knowledgeBaseIds)) {
                return res.status(400).json({ error: 'knowledgeBaseIds must be an array' });
            }
            const { denied } = await partitionAccessibleKBIds(req, knowledgeBaseIds);
            if (denied.length > 0) {
                log.warn('[Notebooks] refused inaccessible kb ids on update:', { notebookId: req.params.id, userId, denied });
                return res.status(403).json({ error: 'One or more knowledge bases are not accessible' });
            }
        }

        // Auto-version: snapshot current content before overwriting (5-min debounce)
        if (documentContent !== undefined) {
            try {
                const nb = await notebookStore.getNotebook(req.params.id, userId);
                if (nb && nb.documentContent && nb.documentContent.trim() && nb.documentContent !== documentContent) {
                    const shouldSnapshot = await notebookStore.shouldAutoVersion(req.params.id);
                    if (shouldSnapshot) {
                        await notebookStore.createVersion(req.params.id, nb.documentContent, 'Auto-save');
                    }
                }
            } catch (vErr) {
                log.warn('[Notebooks] Auto-version failed:', vErr.message);
            }
        }

        // CAS write: `expectedVersion` (when the client sends one) turns
        // last-writer-wins into an explicit 409 the editor can react to.
        const r = await notebookStore.updateNotebookCas(req.params.id, userId, {
            name, description, instructions, settings, knowledgeBaseIds, documentContent, pinned,
            ...(Number.isFinite(expectedVersion) ? { expectedVersion } : {}),
        });
        if (r.ok) return res.json({ success: true, version: r.version });
        if (r.conflict) return res.status(409).json({ error: 'Document was updated elsewhere', code: 'version_conflict' });
        if (r.noop) return res.status(400).json({ error: 'No fields to update' });
        return res.status(404).json({ error: 'Notebook not found' });
    } catch (err) {
        log.error('[Notebooks] Update failed:', err);
        res.status(500).json({ error: 'Failed to update notebook' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
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
        try { require('../core/dlp/dlpRunner').clearConversationState(req.params.id); } catch (_) { /* best-effort */ }

        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete notebook' });
    }
});

// ── Source: File Upload (PDF, DOCX, XLSX, CSV, TXT…) ────────────

router.post('/:id/sources/file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;

        // Verify notebook exists
        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const buffer = req.file.buffer;

        // Determine source type from file extension
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', txt: 'text', md: 'text' };
        const type = typeMap[ext] || 'file';

        // Store file in RustFS
        let storageKey = null;
        if (storageStore.isAvailable()) {
            const storageName = `nb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
            storageKey = storageStore.buildKey(userId, 'notebooks', storageName);
            await storageStore.uploadFile(storageKey, buffer, mimeType);
        }

        // Create source record
        const source = await notebookStore.addSource({
            notebookId, type, name: fileName,
            storageKey, fileName, metadata: { mimeType, size: buffer.length }
        });

        res.json({ success: true, source });

        // Background: parse + ingest into KB
        ingestFileSource(notebookId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            log.error(`[Notebooks] Background ingestion failed for ${fileName}:`, err.message);
        });

    } catch (err) {
        log.error('[Notebooks] File upload failed:', err);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// ── Source: URL ──────────────────────────────────────────────────

router.post('/:id/sources/url', requireAuth, validate({ body: UrlBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        // Derive name from URL
        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await notebookStore.addSource({
            notebookId, type: 'url', name,
            metadata: { url }
        });

        res.json({ success: true, source });

        // Background: fetch + ingest
        ingestUrlSource(notebookId, source.id, userId, url).catch(err => {
            log.error(`[Notebooks] URL ingestion failed for ${url}:`, err.message);
        });

    } catch (err) {
        log.error('[Notebooks] URL source failed:', err);
        res.status(500).json({ error: 'Failed to add URL source' });
    }
});

// ── Source: Pasted Text ─────────────────────────────────────────

router.post('/:id/sources/text', requireAuth, validate({ body: TextBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { text, name } = req.body;
        if (!text) return res.status(400).json({ error: 'Text content required' });

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sourceName = name || 'Pasted text';
        const source = await notebookStore.addSource({
            notebookId, type: 'text', name: sourceName,
            wordCount: countWords(text)
        });

        res.json({ success: true, source });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, text, sourceName).catch(err => {
            log.error(`[Notebooks] Text ingestion failed:`, err.message);
        });

    } catch (err) {
        log.error('[Notebooks] Text source failed:', err);
        res.status(500).json({ error: 'Failed to add text source' });
    }
});

// ── Source: Meeting Notes ─────────────────────────────────────────

router.post('/:id/sources/meeting', requireAuth, validate({ body: MeetingBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { meetingId, mode } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID required' });
        const ingestMode = mode === 'summary' ? 'summary' : 'full';

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const meeting = await transcriptionStore.getTranscription(meetingId, userId);
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const fullTranscript = meeting.fullText || meeting.transcript || meeting.transcription || '';
        const summaryText = meeting.summary || '';
        // Prefer the requested mode; fall back to whichever is populated.
        const sourceText = ingestMode === 'summary'
            ? (summaryText.trim() ? summaryText : fullTranscript)
            : (fullTranscript.trim() ? fullTranscript : summaryText);

        const modeLabel = ingestMode === 'summary' && summaryText.trim() ? ' (summary)' : '';
        const sourceName = `Meeting Note: ${meeting.title || 'Untitled Meeting'}${modeLabel}`;

        if (!sourceText.trim()) return res.status(400).json({ error: 'Meeting has no transcription content' });

        // type 'meeting' (not 'text') so the UI shows the meeting icon, and
        // contentText up front so retry works even if ingestion dies before
        // its own content_text write.
        const source = await notebookStore.addSource({
            notebookId, type: 'meeting', name: sourceName,
            wordCount: countWords(sourceText),
            contentText: sourceText.slice(0, MAX_STORED_TEXT)
        });

        res.json({ success: true, source });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, sourceText, sourceName).catch(err => {
            log.error(`[Notebooks] Meeting source ingestion failed:`, err.message);
        });

    } catch (err) {
        log.error('[Notebooks] Meeting source failed:', err);
        res.status(500).json({ error: 'Failed to add meeting source' });
    }
});

// ── Source: Google Drive / OneDrive ──────────────────────────────

router.post('/:id/sources/drive', requireAuth, validate({ body: DriveBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { files, provider } = req.body; // provider: 'google' | 'microsoft'

        if (!files || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'Files array required' });
        }
        // Bound the batch. Each file below starts a detached ingestion promise —
        // extraction, chunking and embedding — with no concurrency limit, so a
        // single picker selection of a few hundred files could saturate the
        // process (and the embedding backend) for everyone on the instance.
        if (files.length > MAX_DRIVE_FILES_PER_REQUEST) {
            return res.status(400).json({
                error: `Too many files — add at most ${MAX_DRIVE_FILES_PER_REQUEST} at a time`,
                code: 'too_many_files',
            });
        }

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const sources = [];
        for (const file of files) {
            const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
            const source = await notebookStore.addSource({
                notebookId,
                type,
                name: file.name || 'Drive file',
                metadata: {
                    provider,
                    driveFileId: file.driveFileId,
                    charCount: file.content?.length
                },
                wordCount: countWords(file.content)
            });
            sources.push(source);

            // Background: ingest
            if (file.content) {
                ingestDriveSource(notebookId, source.id, userId, file.content, file.name).catch(err => {
                    log.error(`[Notebooks] Drive ingestion failed for ${file.name}:`, err.message);
                });
            } else {
                notebookStore.updateSource(source.id, { status: 'error', error: 'No content received from Drive' });
            }
        }

        res.json({ success: true, sources });

    } catch (err) {
        log.error('[Notebooks] Drive source failed:', err);
        res.status(500).json({ error: 'Failed to add Drive source' });
    }
});

// ── List Sources ────────────────────────────────────────────────

router.get('/:id/sources', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        await notebookStore.timeoutStuckSources(nb.id).catch(() => {});
        const sources = await notebookStore.getSources(nb.id);
        res.json({ sources });
    } catch (err) {
        log.error('[Notebooks] List sources failed:', err);
        res.status(500).json({ error: 'Failed to list sources' });
    }
});

// ── Retry Source Ingestion ──────────────────────────────────────
// Re-runs ingestion for a failed or cancelled source without re-uploading:
//   - file: we fetch the buffer back from storageStore
//   - url:  we re-fetch from the saved URL
//   - text / meeting / gdrive / onedrive: re-ingest the stored content_text
// Only when no stored content survives does retry fail and the UI falls back
// to re-adding the source.

router.post('/:id/sources/:sid/retry', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

        // Reset state so the UI immediately shows the spinner.
        await notebookStore.updateSource(source.id, { status: 'processing', stage: 'queued', error: null });
        res.json({ success: true });

        // Dispatch retry in the background so the HTTP request doesn't stall.
        (async () => {
            try {
                if (source.type === 'url') {
                    const url = source.metadata?.url;
                    if (!url) throw new Error('Source has no URL to retry');
                    await ingestUrlSource(nb.id, source.id, userId, url);
                } else if (source.storageKey) {
                    // File source — re-fetch bytes from storage, re-ingest.
                    if (!storageStore.isAvailable()) throw new Error('Storage not configured');
                    const { stream } = await storageStore.streamFile(source.storageKey);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const mimeType = source.metadata?.mimeType || 'application/octet-stream';
                    await ingestFileSource(nb.id, source.id, userId, buffer, source.fileName || source.name, mimeType);
                } else {
                    // Text / meeting / drive sources now keep their extracted text,
                    // so retry re-ingests from the stored copy.
                    const stored = await notebookStore.getSourceContent(source.id);
                    if (stored && stored.trim()) {
                        await ingestTextSource(nb.id, source.id, userId, stored, source.name);
                    } else {
                        throw new Error('This source type cannot be retried — please re-add it.');
                    }
                }
            } catch (e) {
                log.error(`[Notebooks] Retry failed for source ${source.id}:`, e.message);
                await notebookStore.updateSource(source.id, { status: 'error', error: e.message }).catch(() => {});
            }
        })();
    } catch (err) {
        log.error('[Notebooks] Retry source route failed:', err);
        res.status(500).json({ error: 'Failed to retry source' });
    }
});

// ── Cancel / Dismiss Stuck Source ───────────────────────────────
// Flips a processing or error source to a terminal state without deleting.
// Useful when a worker silently died and the row is stuck yellow — the user
// can dismiss without losing the uploaded bytes (retry remains available).

router.post('/:id/sources/:sid/cancel', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

        await notebookStore.updateSource(source.id, {
            status: 'error',
            stage: 'error',
            error: 'Cancelled by user',
        });
        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Cancel source failed:', err);
        res.status(500).json({ error: 'Failed to cancel source' });
    }
});

// Shared cleanup for a deleted source: storage bytes + KB document chunks.
// Single implementation, shared with the notebook-delete and user-delete
// cascades — see core/notebookCascade.js. It resolves EVERY document derived
// from a source, not just the first, so a re-ingested source doesn't leave
// orphaned chunks behind after its row is gone.
const { cleanupSourceArtifacts } = require('../core/kb/notebookCascade');

// ── Source content (preview) ────────────────────────────────────
router.get('/:id/sources/:sid/content', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
        const content = await notebookStore.getSourceContent(source.id);
        res.json({ content: content || '', name: source.name, type: source.type });
    } catch (err) {
        log.error('[Notebooks] Get source content failed:', err);
        res.status(500).json({ error: 'Failed to load source content' });
    }
});

// ── Reorder sources (must precede the /:sid rename route) ────────
router.patch('/:id/sources/reorder', requireAuth, validate({ body: ReorderBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const { orderedIds } = req.body || {};
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
        await notebookStore.reorderSources(nb.id, orderedIds);
        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Reorder sources failed:', err);
        res.status(500).json({ error: 'Failed to reorder sources' });
    }
});

// ── Rename a source ─────────────────────────────────────────────
router.patch('/:id/sources/:sid', requireAuth, validate({ body: RenameBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
        const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!name) return res.status(400).json({ error: 'Name is required' });
        await notebookStore.updateSource(source.id, { name });
        res.json({ success: true, name });
    } catch (err) {
        log.error('[Notebooks] Rename source failed:', err);
        res.status(500).json({ error: 'Failed to rename source' });
    }
});

// ── Bulk delete sources ─────────────────────────────────────────
router.post('/:id/sources/bulk-delete', requireAuth, validate({ body: BulkDeleteBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        if (ids.length > MAX_BULK_DELETE_IDS) {
            return res.status(400).json({ error: `Too many sources — delete at most ${MAX_BULK_DELETE_IDS} at a time` });
        }
        let deleted = 0;
        for (const sid of ids) {
            // Scoped to nb.id: a foreign sid resolves to null and is skipped, so a
            // caller can't destroy another notebook's source by mixing ids in here.
            const source = await notebookStore.deleteSource(sid, nb.id);
            if (source) { await cleanupSourceArtifacts(nb, source, userId); deleted++; }
        }
        res.json({ success: true, deleted });
    } catch (err) {
        log.error('[Notebooks] Bulk delete sources failed:', err);
        res.status(500).json({ error: 'Failed to delete sources' });
    }
});

// ── Delete Source ───────────────────────────────────────────────

router.delete('/:id/sources/:sid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const source = await notebookStore.deleteSource(req.params.sid, nb.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        await cleanupSourceArtifacts(nb, source, userId);
        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Delete source failed:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// ── Studio: Generate Content (FAQ / Summary / Study Guide) ──────

// Studio generation types. The study-aid / podcast gimmicks were removed
// so older clients calling those types fail loud instead of wasting an LLM
// round-trip for a result nothing renders nicely anymore.
const VALID_GEN_TYPES = new Set([
    'summary', 'briefing_doc', 'blog_post', 'faq',
    'mind_map', 'data_table',
]);
const REMOVED_GEN_TYPES = new Set(['studyGuide', 'flashcards', 'quiz', 'audio_overview']);

router.post('/:id/generate/:type', requireAuth, validate({ body: GenerateBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const type = req.params.type;
        const { modelTier } = req.body;

        if (REMOVED_GEN_TYPES.has(type)) {
            return res.status(400).json({
                error: `Generation type "${type}" was removed. Use Executive Summary, Briefing Doc, FAQ, Mind Map, or Data Table instead.`,
                code: 'generation_type_removed',
            });
        }

        const nb = await notebookStore.getNotebook(notebookId, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        if (!VALID_GEN_TYPES.has(type)) {
            return res.status(400).json({ error: `Unknown generation type "${type}"`, code: 'generation_type_unknown' });
        }

        const sources = await notebookStore.getSources(notebookId);
        const readySources = sources.filter(s => s.status === 'ready');
        // A doc-only notebook is still generatable — gatherNotebookContent
        // folds the document body in below.
        const hasDoc = !!(nb.documentMd || nb.documentContent || '').trim();
        if (readySources.length === 0 && !hasDoc) {
            return res.status(400).json({ error: 'Add a source or write something in the document first' });
        }

        // Gather source content using shared KB search utility
        const { gatherNotebookContent } = require('../core/kb/notebookKnowledgeSearch');
        // Re-authorize at read time — see the PUT handler. Rows written before
        // kb ids were validated may still carry an inaccessible id, and the
        // gather path does no tenant filtering of its own.
        const { allowed: kbIds, denied: _deniedKbIds } = await partitionAccessibleKBIds(req, nb.knowledgeBaseIds || []);
        if (_deniedKbIds.length > 0) {
            log.warn('[Notebooks] dropped inaccessible kb ids on generate:', { notebookId, userId, denied: _deniedKbIds });
        }

        const { content: allContent } = await gatherNotebookContent({
            userId,
            kbIds,
            sources: readySources,
            documentContent: nb.documentContent,
            options: { maxChars: 50000, topK: 25, minScore: 0.15 },
        });

        if (!allContent.trim()) {
            return res.status(400).json({ error: 'Could not retrieve source content from knowledge base' });
        }

        // Type-specific prompts. Only the types in VALID_GEN_TYPES reach here —
        // the check above rejects everything else.
        const typePrompts = {
            faq: `Generate a focused FAQ (Frequently Asked Questions) document based on the source material below.
Format as a well-structured markdown document with clear Q&A pairs grouped by topic. Keep answers concise (2-3 sentences each).`,
            summary: `Generate an executive summary based on the source material below. Include Key Findings and Conclusions.`,
            briefing_doc: `Generate a Briefing Document based on the source material below. Include an Executive Summary, Key Analysis, and Recommendations. Write concisely — prioritize substance over volume.`,
            blog_post: `Draft an engaging, well-written Blog Post based on the core themes of the source material. Use a catchy title, headings, and an accessible tone.`,
            mind_map: `Extract the core concepts from the source material and generate a Mermaid.js mind map visualization.
Wrap your output in \`\`\`mermaid ... \`\`\` tags. Focus on hierarchical relationships between the main topics.`,
            data_table: `Extract the most important quantitative data, comparisons, or structured information from the source material and present it as a Markdown table.`,
        };

        const prompt = typePrompts[type] || typePrompts.summary;

        // Resolve model
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers, resolveEffectiveOrgId } = require('../core/llm/modelResolver');
        const { getAdapter } = require('../core/providers');

        // Resolve user's org for EU-mode tier overrides — cached tier-org (M2),
        // organizationId-only (no group fallback) to preserve the original shape.
        const userOrgId = await resolveEffectiveOrgId(req, { userId, skipGroupFallback: true });

        let resolvedTier = modelTier || 'balanced';

        // Auto mode: classify using the generation type as a pseudo-message
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/llm/promptClassifier');
                const pseudoMessage = `Generate a comprehensive ${type.replace(/([A-Z])/g, ' $1').toLowerCase()} from my notebook sources`;
                const result = await classifyWithLLM(pseudoMessage, tiers, { userOrgId, userId });
                resolvedTier = result.tier;
                log.info(`[Notebooks] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}) for ${type}`);
            } catch (err) {
                log.info(`[Notebooks] Auto classification failed: ${err.message}, using balanced`);
                resolvedTier = 'balanced';
            }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are an expert content generator. Today is ${today}.

${prompt}

CRITICAL RULES:
- You MUST generate content ONLY based on the source material provided below.
- Do NOT use your own knowledge or training data — ONLY use the information in [SOURCE MATERIAL].
- If the source material doesn't contain enough information, generate what you can from it and note any gaps.
- All questions, answers, facts and claims must be directly traceable to the source text below.
- Cite sources using [Source Name] notation when referencing specific information.

MERMAID DIAGRAMS:
- When it adds value (e.g. architecture overviews, process flows, timelines, relationships), include Mermaid.js diagrams using fenced code blocks:
  \`\`\`mermaid
  graph TD
      A[Start] --> B{Decision}
  \`\`\`
- Use diagram types like: graph/flowchart, sequenceDiagram, mindmap, gantt, pie, classDiagram, stateDiagram, erDiagram, timeline.
- Keep diagrams clean and focused — avoid excessive nodes or overly complex layouts.
- Always place diagrams in their own paragraph, not inline with text.

FORMATTING & SPACING:
- Write in a compact, professional style. Avoid filler phrases and redundant introductions.
- NEVER insert double blank lines between sections. Use a single blank line between headings and paragraphs.
- Keep paragraphs concise: 2-4 sentences max. Prefer short, direct sentences.
- Use bullet points and tables where they convey information more efficiently than paragraphs.
- Do NOT add excessive whitespace, padding paragraphs, or "fluff" content.
- Start sections directly with substantive content — skip generic opening sentences like "In this section we will..."
- The output will be rendered on paginated A4/Letter pages, so space-efficient writing is critical.

[SOURCE MATERIAL]
${allContent.slice(0, 50000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Generate the ${type} now. Be thorough but concise — prioritize substance over volume. Use compact formatting with minimal whitespace. Where appropriate, include Mermaid diagrams to visualize key concepts, processes, or relationships.` }
        ];

        const _tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: _tierDefaults.maxTokens,
            temperature: 0.4,
        };


        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                send('content', { text: data.text });
            } else if (streamType === 'thinking') {
                send('thinking', { text: data.text });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });

        // (Removed audio_overview ElevenLabs post-processing — the Audio Podcast
        // generation type was retired. Any cached/legacy callers now hit the
        // REMOVED_GEN_TYPES 400 at the top of this route.)

        send('done', {});
        res.end();

    } catch (err) {
        log.error(`[Notebooks] Generate ${req.params.type} failed:`, err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        } catch { res.status(500).json({ error: 'Generation failed' }); }
    }
});


// ── AI Fill Parameters ────────────────────────────────────────────
// Extracts {{parameter}} placeholders from the document and fills them
// using the notebook's attached sources.
router.post('/:id/ai-fill', requireAuth, validate({ body: AiFillBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const { documentContent, modelTier } = req.body;
        if (!documentContent?.trim()) return res.status(400).json({ error: 'No document content provided' });

        // Extract all {{parameter}} placeholders
        const paramRegex = /\{\{([^}]+)\}\}/g;
        const params = [];
        let match;
        while ((match = paramRegex.exec(documentContent)) !== null) {
            params.push(match[1].trim());
        }
        if (params.length === 0) return res.status(400).json({ error: 'No {{parameters}} found in the document' });

        // Gather source content from KB
        const kbIds = nb.knowledgeBaseIds || [];
        let sourceContent = '';

        if (kbIds.length > 0) {
            const configStore = require('../stores/configStore');
            const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
            
            if (useAzure) {
                const { searchLocally } = require('../core/kb/localKBIngest');
                const sources = await notebookStore.getSources(nb.id);
                for (const source of sources) {
                    if (source.status !== 'ready') continue;
                    try {
                        const localResults = await searchLocally(userId, kbIds, source.name || 'main content', { topK: 30 });
                        if (localResults.length > 0) {
                            sourceContent += `\n--- Source: ${source.name} ---\n`;
                            sourceContent += localResults.map(r => r.content || r.text).join('\n');
                        }
                    } catch (err) {
                        log.warn('[Notebooks] Local search err:', err.message);
                    }
                }
            } else {
                const searchUrl = await configStore.getConfig('search_service_url') || 'https://services.beeflow.nl';
                const searchKey = await configStore.getSecret('search_service_api_key') || '';

                // Fetch all KB content using source names as queries
                const sources = await notebookStore.getSources(nb.id);
                for (const source of sources) {
                    if (source.status !== 'ready') continue;
                    try {
                        const searchRes = await fetch(`${searchUrl}/api/search`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-API-Key': searchKey },
                            body: JSON.stringify({
                                query: source.name || 'main content',
                                kb_ids: kbIds,
                                top_k: 30,
                            }),
                        });
                        if (searchRes.ok) {
                            const data = await searchRes.json();
                            if (data.results?.length > 0) {
                                sourceContent += `\n--- Source: ${source.name} ---\n`;
                                sourceContent += data.results.map(r => r.content || r.text).join('\n');
                            }
                        }
                    } catch {}
                }
            }
        }

        if (!sourceContent.trim()) {
            return res.status(400).json({ error: 'No source content available to fill parameters' });
        }

        // Resolve model  
        const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
        const { resolveModelForTier, getEUAwareTiers, resolveEffectiveOrgId } = require('../core/llm/modelResolver');
        const { getAdapter } = require('../core/providers');

        // Resolve user's org for EU-mode tier overrides — cached tier-org (M2),
        // organizationId-only (no group fallback) to preserve the original shape.
        const userOrgId = await resolveEffectiveOrgId(req, { userId, skipGroupFallback: true });

        let resolvedTier = modelTier || 'balanced';
        if (resolvedTier === 'auto') {
            try {
                const tiers = await getEUAwareTiers({ userOrgId, userId });
                const { classifyWithLLM } = require('../core/llm/promptClassifier');
                const result = await classifyWithLLM('Fill in template parameters in a document using source information', tiers, { userOrgId, userId });
                resolvedTier = result.tier;
            } catch { resolvedTier = 'balanced'; }
        }

        let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });
        if (!modelId) {
            const config = await getAIConfig();
            modelId = config.model;
            if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
        }
        const config = await getProviderForModel(modelId);
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');
        const adapter = getAdapter(config.providerType, apiUrl);

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        const uniqueParams = [...new Set(params)];
        log.info(`[Notebooks] AI Fill: ${uniqueParams.length} unique parameters found for notebook "${nb.name}"`);

        const systemPrompt = `You are a document template filling assistant. Your task is to fill in template parameters in a document using ONLY the provided source material.

The document contains {{parameter_name: description}} placeholders. You must:
1. Read the source material carefully
2. Find the correct value for each parameter from the sources
3. Return the COMPLETE document with ALL {{parameters}} replaced by the correct values
4. Keep ALL other text, HTML formatting, and structure EXACTLY as-is
5. If you cannot find the value for a parameter in the sources, replace it with [UNKNOWN: parameter description]
6. Do NOT add, remove, or change any text outside of the {{parameter}} placeholders

PARAMETERS TO FILL:
${uniqueParams.map((p, i) => `${i + 1}. {{${p}}}`).join('\n')}

SOURCE MATERIAL:
${sourceContent.slice(0, 60000)}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Here is the document. Replace ALL {{parameter}} placeholders with values from the sources. Return the complete document:\n\n${documentContent}` },
        ];

        const _fillDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = { maxTokens: _fillDefaults.maxTokens, temperature: 0.1 };

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (streamType, data) => {
            if (streamType === 'text') {
                send('content', { text: data.text });
            } else if (streamType === 'error') {
                send('error', data);
            }
        });

        send('done', { params: uniqueParams.length });
        res.end();
    } catch (err) {
        log.error('[Notebooks] AI Fill failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'AI Fill failed: ' + err.message });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        }
    }
});


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

router.post('/:id/images', requireAuth, imageUpload.single('image'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;

        // Allow 'workspace' as a virtual notebook ID for the workspace notebook pane
        if (notebookId !== 'workspace') {
            const nb = await notebookStore.getNotebook(notebookId, userId);
            if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        }
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

    } catch (err) {
        log.error('[Notebooks] Image upload failed:', err);
        res.status(500).json({ error: 'Image upload failed' });
    }
});

// ── Import File to Editor (PDF, DOCX, TXT...) ────────────────────

router.post('/:id/import-file', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { parseDocument } = require('../core/documents/documentParser');
        const text = await parseDocument(req.file.buffer, req.file.mimetype, req.file.originalname, { returnHtml: true });

        res.json({ success: true, text });
    } catch (err) {
        log.error('[Notebooks] Import file failed:', err);
        res.status(500).json({ error: 'Failed to parse file for import' });
    }
});

// ── Version Control ─────────────────────────────────────────────────

// List versions (metadata only)
router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const versions = await notebookStore.getVersions(req.params.id);
        res.json({ versions });
    } catch (err) {
        log.error('[Notebooks] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

// Get a single version with full content
router.get('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const version = await notebookStore.getVersion(req.params.vid);
        if (!version || version.notebookId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        res.json({ version });
    } catch (err) {
        log.error('[Notebooks] Get version failed:', err);
        res.status(500).json({ error: 'Failed to get version' });
    }
});

// Create a manual snapshot
router.post('/:id/versions', requireAuth, validate({ body: VersionBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const summary = req.body.summary || 'Manual snapshot';
        // Prefer the content the client is actually looking at. Snapshotting the
        // last PERSISTED value meant a "Before restore" snapshot silently
        // omitted everything still inside the editor's save debounce — while
        // the restore dialog promised the current document was safe.
        const clientContent = typeof req.body.content === 'string' ? req.body.content : null;
        const content = (clientContent && clientContent.trim()) ? clientContent : (nb.documentContent || '');
        if (!content.trim()) {
            return res.status(400).json({ error: 'Notebook is empty — nothing to snapshot' });
        }

        const version = await notebookStore.createVersion(req.params.id, content, summary);
        res.json({ success: true, version });
    } catch (err) {
        log.error('[Notebooks] Create version failed:', err);
        res.status(500).json({ error: 'Failed to create version' });
    }
});

// Delete a version
router.delete('/:id/versions/:vid', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) return res.status(404).json({ error: 'Notebook not found' });

        const ok = await notebookStore.deleteVersion(req.params.vid, nb.id);
        if (!ok) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        log.error('[Notebooks] Delete version failed:', err);
        res.status(500).json({ error: 'Failed to delete version' });
    }
});

module.exports = router;
