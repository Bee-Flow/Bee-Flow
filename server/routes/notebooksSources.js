/**
 * Notebook source routes, mounted by routes/notebooks.js at the same place in
 * its route table.
 *
 * Endpoints:
 *   POST   /:id/sources/file          — upload file source (pdf, docx, xlsx, txt…)
 *   POST   /:id/sources/url           — add URL source
 *   POST   /:id/sources/text          — paste text source
 *   POST   /:id/sources/meeting       — add meeting notes
 *   POST   /:id/sources/drive         — import from Google Drive / OneDrive
 *   GET    /:id/sources               — list sources
 *   POST   /:id/sources/:sid/retry    — re-run ingestion
 *   POST   /:id/sources/:sid/cancel   — dismiss a stuck source
 *   GET    /:id/sources/:sid/content  — preview
 *   PATCH  /:id/sources/reorder       — reorder
 *   PATCH  /:id/sources/:sid          — rename
 *   POST   /:id/sources/bulk-delete   — remove several
 *   DELETE /:id/sources/:sid          — remove source
 *
 * Moved here unchanged from routes/notebooks.js. Viewers read, editors change
 * the sources (routes/notebooksAccess.js).
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const notebookStore = require('../stores/notebookStore');
const storageStore = require('../stores/storageStore');
const transcriptionStore = require('../stores/transcriptionStore');
const { ingestFileSource, ingestUrlSource, ingestTextSource, ingestDriveSource, MAX_STORED_TEXT, MAX_SOURCE_TEXT_CHARS, MAX_SOURCES_PER_NOTEBOOK } = require('../agents/notebooks/sourceIngestion');
const { countWords } = require('../utils/text');
const { keepUploadedSource } = require('../core/documents/uploadedSource');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, choice, typeError } = require('../core/http/schemaParts');
const { HttpError } = require('../core/http/errors');
const { friendlyError } = require('../core/kb/friendlyError');
const { mapWithConcurrency } = require('../core/concurrencyUtil');
const { asViewer, asEditor, seams, upload, text, ids } = require('./notebooksShared');
// requireAuth is the canonical gate from auth/permissions (see routes/notebooks.js).
const { requireAuth } = require('../auth/permissions');

// Upper bound on a single bulk-delete request. Caps both accidental runaway
// clients and id-enumeration attempts against the scoped delete.
const MAX_BULK_DELETE_IDS = 100;

// Upper bound on a single Drive/OneDrive import. Each file spawns a detached
// ingestion job, so this is the only thing standing between one picker
// selection and an unbounded fan-out.
const MAX_DRIVE_FILES_PER_REQUEST = 25;

// Source limits (MAX_SOURCE_TEXT_CHARS, MAX_SOURCES_PER_NOTEBOOK) come from
// sourceIngestion.js; the checks below run before any row is inserted.
// Bulk-delete cleanup (storage + chunk deletes) runs this many sources at a time.
const SOURCE_CLEANUP_CONCURRENCY = 5;

/** Refuses (413 `source_text_too_large`) a piece of pasted or imported text over the cap. */
function assertTextFits(...texts) {
    if (!texts.some((t) => typeof t === 'string' && t.length > MAX_SOURCE_TEXT_CHARS)) return;
    throw new HttpError(413, 'source_text_too_large',
        `This text is too long (over ${MAX_SOURCE_TEXT_CHARS.toLocaleString('en-US')} characters). Split it into smaller sources.`);
}

/** 409 when adding `adding` sources would push the notebook past its cap. */
async function assertSourceRoom(notebookId, adding = 1) {
    const have = await notebookStore.countSources(notebookId);
    if (have + adding > MAX_SOURCES_PER_NOTEBOOK) {
        throw new HttpError(409, 'notebook_source_limit',
            `A notebook holds at most ${MAX_SOURCES_PER_NOTEBOOK} sources. Remove some before adding more.`,
            { limit: MAX_SOURCES_PER_NOTEBOOK, current: have });
    }
}

// ── What a caller may send ─────────────────────────────────────────
// Closed bodies (see routes/notebooksShared.js). sources/file reads the file
// and nothing else.
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
    }, { error: typeError({ invalid: DRIVE_FILE_TEXT }) }), { error: typeError({ required: 'Files array required', invalid: DRIVE_FILE_TEXT }) }),
    provider: choice(['google', 'microsoft'], 'provider is google or microsoft.').optional(),
}, 'Importing from Drive');
const ReorderBody = bodyOf({ orderedIds: ids('orderedIds must be an array') }, 'Reordering sources');
const RenameBody = bodyOf({ name: text('Name is required', 2000) }, 'Renaming a source');
const BulkDeleteBody = bodyOf({ ids: ids('ids is a list of source ids.') }, 'Deleting sources');

// ── Source: File Upload (PDF, DOCX, XLSX, CSV, TXT…) ────────────

router.post('/:id/sources/file', requireAuth, asEditor, upload.single('file'), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;

        const nb = req.notebook;
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        await assertSourceRoom(nb.id);

        // Source type from the extension, and a copy in RustFS when storage is on.
        const uploaded = await require('../db').withTransaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM notebooks WHERE id = $1 FOR UPDATE', [notebookId]);
            if (!rows[0]) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');
            const contentCrypto = require('../stores/lib/documentCrypto');
            const resource = contentCrypto.resourceOf(rows[0], 'notebook');
            const context = await contentCrypto.writeContext(resource);
            const file = await keepUploadedSource(req.file, {
                userId, prefix: 'nb', folder: 'notebooks',
                protectBuffer: context ? (bytes, key) => require('../stores/lib/notebookFileCrypto').sealBuffer(resource, key, bytes, context) : null,
            });
            try {
                const source = await notebookStore.addSource({
                    notebookId, type: file.type, name: file.fileName,
                    storageKey: file.storageKey, fileName: file.fileName, metadata: { mimeType: file.mimeType, size: file.buffer.length }, client,
                });
                return { ...file, source };
            } catch (e) {
                if (file.storageKey) await require('../stores/storageStore').deleteFile(file.storageKey).catch(() => undefined);
                throw e;
            }
        });
        const { fileName, mimeType, buffer, source } = uploaded;

        res.json({ success: true, source });
        void seams.feed().sourcesAdded({ projectId: nb.projectId, notebookId, actorId: userId });

        // Background: parse + ingest into KB
        ingestFileSource(notebookId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            log.error(`[Notebooks] Background ingestion failed for ${fileName}:`, err.message);
        });

    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] File upload failed:', err);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// ── Source: URL ──────────────────────────────────────────────────

router.post('/:id/sources/url', requireAuth, validate({ body: UrlBody }), asEditor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const nb = req.notebook;
        await assertSourceRoom(nb.id);

        // Derive name from URL
        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await notebookStore.addSource({
            notebookId, type: 'url', name,
            metadata: { url }
        });

        res.json({ success: true, source });
        void seams.feed().sourcesAdded({ projectId: nb.projectId, notebookId, actorId: userId });

        // Background: fetch + ingest
        ingestUrlSource(notebookId, source.id, userId, url).catch(err => {
            log.error(`[Notebooks] URL ingestion failed for ${url}:`, err.message);
        });

    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] URL source failed:', err);
        res.status(500).json({ error: 'Failed to add URL source' });
    }
});

// ── Source: Pasted Text ─────────────────────────────────────────

router.post('/:id/sources/text', requireAuth, validate({ body: TextBody }), asEditor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { text, name } = req.body;
        if (!text) return res.status(400).json({ error: 'Text content required' });

        const nb = req.notebook;
        assertTextFits(text);
        await assertSourceRoom(nb.id);

        const sourceName = name || 'Pasted text';
        const source = await notebookStore.addSource({
            notebookId, type: 'text', name: sourceName,
            wordCount: countWords(text)
        });

        res.json({ success: true, source });
        void seams.feed().sourcesAdded({ projectId: nb.projectId, notebookId, actorId: userId });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, text, sourceName).catch(err => {
            log.error(`[Notebooks] Text ingestion failed:`, err.message);
        });

    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] Text source failed:', err);
        res.status(500).json({ error: 'Failed to add text source' });
    }
});

// ── Source: Meeting Notes ─────────────────────────────────────────

router.post('/:id/sources/meeting', requireAuth, validate({ body: MeetingBody }), asEditor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebookId = req.params.id;
        const { meetingId, mode } = req.body;
        if (!meetingId) return res.status(400).json({ error: 'Meeting ID required' });
        const ingestMode = mode === 'summary' ? 'summary' : 'full';

        const nb = req.notebook;
        await assertSourceRoom(nb.id);

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
            notebookId, type: 'meeting', name: sourceName, sourceRefId: meeting.id,
            wordCount: countWords(sourceText),
            contentText: sourceText.slice(0, MAX_STORED_TEXT)
        });

        res.json({ success: true, source });
        void seams.feed().sourcesAdded({ projectId: nb.projectId, notebookId, actorId: userId });

        // Background: ingest
        ingestTextSource(notebookId, source.id, userId, sourceText, sourceName).catch(err => {
            log.error(`[Notebooks] Meeting source ingestion failed:`, err.message);
        });

    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] Meeting source failed:', err);
        res.status(500).json({ error: 'Failed to add meeting source' });
    }
});

// ── Source: Google Drive / OneDrive ──────────────────────────────

router.post('/:id/sources/drive', requireAuth, validate({ body: DriveBody }), asEditor, async (req, res) => {
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

        const nb = req.notebook;

        // Everything that can refuse the request is checked before the first row
        // is inserted, so a refused import leaves no half-added sources behind.
        assertTextFits(...files.map((f) => f.content));
        await assertSourceRoom(nb.id, files.length);

        const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
        const sources = [];
        const empty = [];
        // Sequential on purpose: each insert takes the next sort_order, so the
        // list keeps the order the picker sent. At most 25 cheap inserts.
        for (const file of files) {
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
                empty.push(source);
            }
        }
        if (empty.length > 0) {
            const emptyError = friendlyError('No content received from Drive');
            await Promise.all(empty.map((source) => {
                source.status = 'error';
                source.stage = 'error';
                source.error = emptyError;
                return notebookStore.updateSource(source.id, { status: 'error', stage: 'error', error: emptyError })
                    .catch(e => log.warn(`[Notebooks] could not mark empty Drive source ${source.id}:`, e.message));
            }));
        }

        res.json({ success: true, sources });
        void seams.feed().sourcesAdded({ projectId: nb.projectId, notebookId, actorId: userId, count: sources.length });

    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] Drive source failed:', err);
        res.status(500).json({ error: 'Failed to add Drive source' });
    }
});

// ── List Sources ────────────────────────────────────────────────

router.get('/:id/sources', requireAuth, asViewer, async (req, res) => {
    const nb = req.notebook;

    await notebookStore.timeoutStuckSources(nb.id).catch(() => {});
    const sources = await notebookStore.getSources(nb.id);
    res.json({ sources });
});

// ── Retry Source Ingestion ──────────────────────────────────────
// Re-runs ingestion for a failed or cancelled source without re-uploading:
//   - file: we fetch the buffer back from storageStore
//   - url:  we re-fetch from the saved URL
//   - text / meeting / gdrive / onedrive: re-ingest the stored content_text
// Only when no stored content survives does retry fail and the UI falls back
// to re-adding the source.

router.post('/:id/sources/:sid/retry', requireAuth, asEditor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const nb = req.notebook;

        const source = await notebookStore.getSource(req.params.sid);
        if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

        // Reset state so the UI immediately shows the spinner. A source that is
        // still being read is not started a second time.
        if (!await notebookStore.claimSourceForRetry(source.id)) {
            throw new HttpError(409, 'source_busy', 'This source is still being read. Wait for it to finish, or cancel it first.');
        }
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
                    const buffer = await require('../stores/lib/notebookFileCrypto').readBuffer(source.storageKey);
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
                // Conditional: a cancel/delete during the retry wins.
                await notebookStore.updateSource(
                    source.id,
                    { status: 'error', stage: 'error', error: friendlyError(e) },
                    { onlyIfProcessing: true },
                ).catch(() => {});
            }
        })();
    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.error('[Notebooks] Retry source route failed:', err);
        res.status(500).json({ error: 'Failed to retry source' });
    }
});

// ── Cancel / Dismiss Stuck Source ───────────────────────────────
// Flips a processing or error source to a terminal state without deleting.
// Useful when a worker silently died and the row is stuck yellow — the user
// can dismiss without losing the uploaded bytes (retry remains available).

router.post('/:id/sources/:sid/cancel', requireAuth, asEditor, async (req, res) => {
    const nb = req.notebook;

    const source = await notebookStore.getSource(req.params.sid);
    if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });

    // Only a source that is still being worked on (or already failed) can be
    // cancelled; a finished one must not be flipped to error. The running
    // ingestion notices the change before it embeds / marks ready and
    // discards what it wrote (agents/notebooks/sourceIngestion.js).
    if (source.status === 'processing') {
        await notebookStore.updateSource(source.id, {
            status: 'error',
            stage: 'error',
            error: 'Cancelled by user',
        }, { onlyIfProcessing: true });
    }
    res.json({ success: true });
});

// Shared cleanup for a deleted source: storage bytes + KB document chunks.
// Single implementation, shared with the notebook-delete and user-delete
// cascades — see core/notebookCascade.js. It resolves EVERY document derived
// from a source, not just the first, so a re-ingested source doesn't leave
// orphaned chunks behind after its row is gone.
const { cleanupSourceArtifacts } = require('../core/kb/notebookCascade');

// ── Source content (preview) ────────────────────────────────────
router.get('/:id/sources/:sid/content', requireAuth, asViewer, async (req, res) => {
    const nb = req.notebook;
    const source = await notebookStore.getSource(req.params.sid);
    if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
    const content = await notebookStore.getSourceContent(source.id);
    res.json({ content: content || '', name: source.name, type: source.type });
});

// ── Reorder sources (must precede the /:sid rename route) ────────
router.patch('/:id/sources/reorder', requireAuth, validate({ body: ReorderBody }), asEditor, async (req, res) => {
    const nb = req.notebook;
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    await notebookStore.reorderSources(nb.id, orderedIds);
    res.json({ success: true });
});

// ── Rename a source ─────────────────────────────────────────────
router.patch('/:id/sources/:sid', requireAuth, validate({ body: RenameBody }), asEditor, async (req, res) => {
    const nb = req.notebook;
    const source = await notebookStore.getSource(req.params.sid);
    if (!source || source.notebookId !== nb.id) return res.status(404).json({ error: 'Source not found' });
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    await notebookStore.updateSource(source.id, { name });
    res.json({ success: true, name });
});

// ── Bulk delete sources ─────────────────────────────────────────
router.post('/:id/sources/bulk-delete', requireAuth, validate({ body: BulkDeleteBody }), asEditor, async (req, res) => {
    const nb = req.notebook;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length > MAX_BULK_DELETE_IDS) {
        return res.status(400).json({ error: `Too many sources — delete at most ${MAX_BULK_DELETE_IDS} at a time` });
    }
    // One scoped DELETE ... WHERE id = ANY: a foreign sid simply doesn't match,
    // so a caller can't destroy another notebook's source by mixing ids in.
    const removed = await notebookStore.deleteSources(ids, nb.id);
    // Chunks live under the notebook owner's tenant (sourceIngestion.js).
    await mapWithConcurrency(removed, SOURCE_CLEANUP_CONCURRENCY, (source) => cleanupSourceArtifacts(nb, source, nb.userId));
    const deleted = removed.length;
    res.json({ success: true, deleted });
});

// ── Delete Source ───────────────────────────────────────────────

router.delete('/:id/sources/:sid', requireAuth, asEditor, async (req, res) => {
    const nb = req.notebook;

    const source = await notebookStore.deleteSource(req.params.sid, nb.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    // Chunks live under the notebook owner's tenant (sourceIngestion.js).
    await cleanupSourceArtifacts(nb, source, nb.userId);
    res.json({ success: true });
});

module.exports = router;
