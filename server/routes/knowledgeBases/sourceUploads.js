/**
 * Knowledge Bases — sources (K1): files for an upload source
 * (POST /:id/sources/:sid/files). The multer plumbing, the 202 that answers
 * before processing, the detached processing itself and the helper that lets
 * tests (and a graceful shutdown) wait for it. The route is registered in
 * sources.js. Split out of sources.js; behaviour unchanged.
 */

const multer = require('multer');
const log = require('../../telemetry/log');
const kbStore = require('../../stores/knowledgeBases');
const { getUserId } = require('./shared');
const { MAX_UPLOAD_FILES, MAX_FILE_BYTES, QUEUED_REASON, helpers, resolveKb, resolveSource } = require('./sourcePolicy');

const uploadFiles = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_UPLOAD_FILES },
}).any();

/**
 * Multer as middleware with its errors turned into JSON. `.any()` so the
 * client may post `files` (the new multi-file form) or `file` (one file, the
 * shape the old upload modal used) without a second endpoint.
 */
function acceptUploads(req, res, next) {
    uploadFiles(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `Each file must be 20 MB or smaller`, code: 'file_too_large' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: `At most ${MAX_UPLOAD_FILES} files per upload`, code: 'too_many_files' });
        }
        return res.status(400).json({ error: err.message, code: 'upload_failed' });
    });
}

/**
 * In-flight detached upload jobs. The route answers 202 and processes after
 * the response, so tests (and, later, a graceful shutdown) need a way to wait
 * for the work instead of racing it.
 */
const pendingUploads = new Set();

function trackUpload(promise) {
    const job = Promise.resolve(promise).catch((e) => {
        log.error('[KB] Upload processing failed:', e && e.message ? e.message : e);
    });
    pendingUploads.add(job);
    job.then(() => pendingUploads.delete(job), () => pendingUploads.delete(job));
    return job;
}

/** Await every detached upload job. Test/shutdown helper — not a route. */
async function settleUploads() {
    while (pendingUploads.size > 0) {
        await Promise.all(Array.from(pendingUploads));
    }
}

/**
 * Turn one accepted upload into a processed document.
 *
 * The row already exists (created by the route so the 202 can hand back real
 * document ids); this fills it in under the SAME id — which is also what
 * "process again" will do later.
 */
async function processUploadedFile(kb, source, doc, file) {
    const { extractFileContentWithMeta, reingestDocument, friendlyError } = helpers();
    let text = '';
    let meta = {};
    try {
        const extracted = await extractFileContentWithMeta(file.buffer, file.mimetype, file.originalname);
        text = extracted.text || '';
        meta = extracted.meta || {};
    } catch (e) {
        log.warn(`[KB] Extraction failed for "${file.originalname}": ${e.message}`);
        await kbStore.updateDocumentStatus(doc.id, {
            status: 'error', statusReason: friendlyError(e), chunkCount: 0,
        }).catch(() => {});
        return;
    }

    // Dedup, in the same scope ingestDocument would apply: an identical file
    // already in THIS source is an alias, not a second embedding. (Rows in
    // another source stay separate — K4 annotates those as overlaps.)
    if (text && text.trim().length >= 3) {
        try {
            const existing = await kbStore.findDocumentByContentHash(kb.id, kbStore.hashContent(text));
            if (existing && String(existing.id) !== String(doc.id)
                && (!existing.source_id || String(existing.source_id) === String(source.id))) {
                await kbStore.updateDocumentStatus(doc.id, {
                    status: 'duplicate',
                    statusReason: 'Identical content already in this knowledge base',
                    chunkCount: 0,
                });
                return;
            }
        } catch (e) {
            log.warn('[KB] Duplicate probe failed, ingesting anyway:', e.message);
        }
    }

    await reingestDocument(kb.tenant_id, kb.id, doc.id, text, {
        title: file.originalname,
        sizeBytes: file.size != null ? file.size : (file.buffer ? file.buffer.length : null),
        mime: file.mimetype || null,
        pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : null,
        sheetCount: Array.isArray(meta.sheetNames) ? meta.sheetNames.length : null,
        // The pages themselves, so each chunk can carry the page it starts on
        // and a citation reads "Handboek · p. 12" rather than "Handboek".
        pages: Array.isArray(meta.pages) ? meta.pages : null,
        externalId: file.originalname,
        onFailure: 'record',
    });
}

/**
 * The row is created up front, parked as 'skipped' with a reason, because
 * 'processing' is not a documents.status value and inventing one would mean
 * a schema change on a rolling deploy. A crash between accept and finish
 * therefore leaves a visible "not processed yet" row the user can retry,
 * never a silently missing file.
 */
function acceptFile(kb, source, file, userId) {
    return kbStore.createDocument(
        kb.tenant_id, kb.id, file.originalname, 'upload', file.originalname,
        null, 0, null, null,
        {
            sourceId: source.id, externalId: file.originalname, createdBy: userId,
            sizeBytes: file.size != null ? file.size : (file.buffer ? file.buffer.length : null),
            mime: file.mimetype || null,
            status: 'skipped', statusReason: QUEUED_REASON,
        },
    );
}

/** POST /:id/sources/:sid/files — add files to an upload source (202). */
async function addFiles(req, res, next) {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;
        const source = await resolveSource(kb, req, res);
        if (!source) return;
        if (source.kind !== 'upload') {
            return res.status(400).json({ error: 'Files can only be added to an upload source', code: 'not_an_upload_source' });
        }
        const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
        if (files.length === 0) return res.status(400).json({ error: 'No files uploaded', code: 'no_files' });

        const userId = getUserId(req);
        const accepted = [];
        for (const file of files) accepted.push({ doc: await acceptFile(kb, source, file, userId), file });

        // Answer first, process after: a 40 MB PDF batch must not hold the
        // request open. K3 replaces this with the refresh job.
        res.status(202).json({
            accepted: accepted.length,
            documents: accepted.map(({ doc, file }) => ({
                id: doc.id,
                name: file.originalname,
                status: 'processing',
            })),
        });

        trackUpload((async () => {
            for (const { doc, file } of accepted) {
                try {
                    await processUploadedFile(kb, source, doc, file);
                } catch (e) {
                    log.error(`[KB] Upload "${file.originalname}" failed:`, e.message);
                    await kbStore.updateDocumentStatus(doc.id, {
                        status: 'error', statusReason: helpers().friendlyError(e), chunkCount: 0,
                    }).catch(() => {});
                }
            }
        })());
    } catch (e) {
        log.error('[KB] Source upload error:', e.message);
        if (!res.headersSent) next(e);
    }
}

module.exports = { acceptUploads, settleUploads, addFiles };
