/**
 * Knowledge Bases — text, file and URL ingestion.
 *
 * The three hand-fed sources: a pasted snippet, an uploaded file (extracted
 * in-process) and a single web page (fetched through fetchUrlContent, which
 * carries its own SSRF screening).
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const multer = require('multer');
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, requirePermission } = require('../../auth');
const {
    extractFileContentWithMeta,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kb/kbIngestionHelpers');
const { getUserId, canAccessKB, blockIfSystemKB, ensureKbSource } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// Both schemas are `.strict()`: a key this router does not read is a client
// bug, and answering 201 to it means the document is filed without the title
// the person typed, with nothing on screen to say so.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CONTENT_TEXT = 'A text snippet needs at least three characters of text.';
const IngestTextBody = z.object({
    // Refined rather than trimmed: the snippet is stored and counted as it
    // was typed, so trimming it here would change what got saved.
    content: worded(CONTENT_TEXT).refine((v) => v.trim().length >= 3, CONTENT_TEXT),
    title: worded('A title must be text.').trim().max(200, 'A title is at most 200 characters.').optional(),
}).strict();

const URL_TEXT = 'An address is required — the page to read.';
const IngestUrlBody = z.object({
    // Whether the address is one this install may fetch is fetchUrlContent's
    // answer: it screens the host and every address it resolves to.
    url: worded(URL_TEXT).trim().min(1, URL_TEXT),
}).strict();

// Multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// ── Ingestion ───────────────────────────────────────────────────────

/**
 * Ingest text content into a KB
 */
router.post('/:id/ingest/text', requireAuth, requirePermission('manage_knowledge'), validate({ body: IngestTextBody }), async (req, res, next) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
        if (blockIfSystemKB(kb, res)) return;

        const { content, title } = req.body;

        // One `text` source per pasted snippet (keyed on its title), so this
        // legacy route produces exactly what POST /:id/sources produces.
        const docTitle = title || 'Text snippet';
        const source = await ensureKbSource(kb.id, 'text', {
            name: docTitle,
            config: { title: docTitle, charCount: content.length },
            configMatch: { title: docTitle },
            createdBy: getUserId(req),
        });

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            docTitle, 'text', null,
            { sourceId: source ? source.id : null, createdBy: getUserId(req) }
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: e.message, documentId: e.documentId });
        }
        log.error('[KB] Ingest text error:', e.message);
        next(e);
    }
});

/**
 * Ingest file into a KB
 */
router.post('/:id/ingest/file', requireAuth, requirePermission('manage_knowledge'), upload.single('file'), async (req, res, next) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
        if (blockIfSystemKB(kb, res)) return;

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const mime = req.file.mimetype;
        const filename = req.file.originalname;

        // Extract text from file via shared helpers. The …WithMeta variant
        // returns the identical text plus what we learned on the way (page and
        // sheet counts), which the source model stores on the document.
        const { text: content, meta } = await extractFileContentWithMeta(req.file.buffer, mime, filename);

        if (!content || content.trim().length < 10) {
            return res.status(400).json({ error: 'Could not extract text from file' });
        }

        // One `upload` source per KB — "the uploaded files of this KB".
        const source = await ensureKbSource(kb.id, 'upload', {
            name: 'Uploaded files',
            config: {},
            createdBy: getUserId(req),
        });

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            filename, 'upload', filename,
            {
                sourceId: source ? source.id : null,
                externalId: filename,
                createdBy: getUserId(req),
                sizeBytes: req.file.size != null ? req.file.size : (req.file.buffer ? req.file.buffer.length : null),
                mime,
                pageCount: Number.isFinite(meta && meta.pageCount) ? meta.pageCount : null,
                sheetCount: Array.isArray(meta && meta.sheetNames) ? meta.sheetNames.length : null,
                // The pages themselves, so each chunk carries the page it
                // starts on and a citation can be checked against the document.
                pages: Array.isArray(meta && meta.pages) ? meta.pages : null,
            }
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'Duplicate content', documentId: e.documentId });
        }
        log.error('[KB] Ingest file error:', e.message);
        next(e);
    }
});

/**
 * Ingest URL into a KB
 */
router.post('/:id/ingest/url', requireAuth, requirePermission('manage_knowledge'), validate({ body: IngestUrlBody }), async (req, res, next) => {
    try {
        const kb = await kbStore.getKB(req.params.id);
        if (!kb) return res.status(404).json({ error: 'KB not found' });
        if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
        if (blockIfSystemKB(kb, res)) return;

        const { url } = req.body;

        // Fetch and convert to markdown via shared helper
        const { content, title: pageTitle, resolvedUrl } = await fetchUrlContent(url);

        // One `webpage` source per URL — re-ingesting the same page reuses it.
        const source = await ensureKbSource(kb.id, 'webpage', {
            name: String(pageTitle || resolvedUrl || url).slice(0, 200),
            config: { url: resolvedUrl },
            configMatch: { url: resolvedUrl },
            createdBy: getUserId(req),
        });

        const result = await ingestDocument(
            kb.tenant_id, kb.id, content,
            pageTitle, 'web', resolvedUrl,
            {
                sourceId: source ? source.id : null,
                externalId: resolvedUrl,
                createdBy: getUserId(req),
                mime: 'text/html',
            }
        );

        res.status(201).json({
            success: true,
            document: result.document,
            chunks: result.chunks,
            source: resolvedUrl
        });
    } catch (e) {
        if (e.code === 'DUPLICATE') {
            return res.status(409).json({ error: 'This URL content already exists', documentId: e.documentId });
        }
        if (e.message.includes('Invalid URL') || e.message.includes('Only HTTP')) {
            return res.status(400).json({ error: e.message });
        }
        if (e.message.includes('Fetch failed')) {
            return next(new HttpError(502, 'fetch_failed', e.message));
        }
        log.error('[KB] Ingest URL error:', e.message);
        next(e);
    }
});
module.exports = router;
