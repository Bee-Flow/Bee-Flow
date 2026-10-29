/**
 * De bronnen die een pagina leest: bestand, URL, geplakte tekst en Drive —
 * plus opsommen, opnieuw proberen, afbreken en verwijderen.
 *
 * POST /:id/sources/{file,url,text,drive}  ·  GET /:id/sources
 * POST /:id/sources/:sid/{retry,cancel}    ·  DELETE /:id/sources/:sid
 */

const webpageStore = require('../../stores/webpageStore');
const storageStore = require('../../stores/storageStore');
const { requireAuth } = require('../../auth/permissions');
const {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
} = require('../../agents/webpages/sourceIngestion');
const { deleteDocumentChunks, findDocumentBySourceUri } = require('../../core/kb/kbIngestionHelpers');
const { keepUploadedSource } = require('../../core/documents/uploadedSource');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded, bodyOf, choice, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

// ── What a source may carry ─────────────────────────────────────────
//
// `provider` is an enum, and that is the reason this file got a schema.
// It stood there as `provider === 'microsoft' ? 'onedrive' : 'gdrive'`: EVERY other
// value — 'Microsoft' with a capital, 'onedrive', a typo — put the source down as a
// Google Drive file. The row in the sources panel then carried the wrong icon and the
// wrong origin, and `metadata.provider` meanwhile kept the raw value: two fields on one
// row that contradict each other.
const PROVIDER_TEXT = 'Kies een aanbieder: google of microsoft.';
const URL_TEXT = 'URL required';
const TEXT_TEXT = 'Text content required';
const FILES_TEXT = 'Files array required';

const UrlBody = bodyOf({ url: worded(URL_TEXT).trim().min(1, URL_TEXT) });

const TextBody = bodyOf({
    text: worded(TEXT_TEXT).min(1, TEXT_TEXT),
    name: worded('Een naam is tekst.').trim().max(200, 'Een naam is hoogstens 200 tekens.').optional(),
});

const DriveBody = bodyOf({
    provider: choice(['google', 'microsoft'], PROVIDER_TEXT),
    // The content of one Drive file as the picker has already read it.
    // Its shape is that of the picker, not of this route.
    files: z.array(z.unknown(), { error: FILES_TEXT }).min(1, FILES_TEXT),
});

function register(router, { upload }) {
    // ── Source: File Upload ────────────────────────────────────────────

    // Multipart, so the schema sits BEHIND multer: that fills `req.body` only after it has
    // read the stream. This route reads nothing from it — the name, the type and the bytes all
    // come from `req.file` — and says so with an empty strict body instead of letting it pass silently.
    router.post('/:id/sources/file', requireAuth, validate({ query: NO_QUERY }), upload.single('file'),
        validate({ body: NOTHING }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const webpageId = req.params.id;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const { fileName, mimeType, buffer, type, storageKey } = await keepUploadedSource(req.file, {
            userId, prefix: 'wp', folder: 'webpage-sources',
        });

        const source = await webpageStore.addSource({
            webpageId, type, name: fileName,
            storageKey, fileName, metadata: { mimeType, size: buffer.length },
        });

        res.json({ success: true, source });

        ingestFileSource(webpageId, source.id, userId, buffer, fileName, mimeType).catch(err => {
            log.error(`[Webpages] Background ingestion failed for ${log.nameForLog(fileName)}:`, err.message);
        });
    });

    router.post('/:id/sources/url', requireAuth, validate({ body: UrlBody, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof UrlBody>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { url } = req.body;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // SSRF guard — reject internal/loopback/link-local hosts up-front so
        // the user sees a clear error instead of an ingestion task that
        // mysteriously transitions to "error" later.
        try {
            const { assertUrlIsPublic } = require('../../core/kb/kbIngestionHelpers');
            await assertUrlIsPublic(url);
        } catch (e) {
            return res.status(400).json({ error: /** @type {Error} */ (e).message || 'URL is not allowed' });
        }

        /** @type {string} */
        let name;
        try { name = new URL(url).hostname + new URL(url).pathname; } catch { name = url; }
        if (name.length > 80) name = name.slice(0, 80) + '…';

        const source = await webpageStore.addSource({
            webpageId, type: 'url', name, metadata: { url },
        });

        res.json({ success: true, source });

        ingestUrlSource(webpageId, source.id, userId, url).catch(err => {
            log.error(`[Webpages] URL ingestion failed for ${url}:`, err.message);
        });
    });

    router.post('/:id/sources/text', requireAuth, validate({ body: TextBody, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof TextBody>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { text, name } = req.body;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sourceName = name || 'Pasted text';
        const source = await webpageStore.addSource({
            webpageId, type: 'text', name: sourceName,
            wordCount: text.split(/\s+/).length,
        });

        res.json({ success: true, source });

        ingestTextSource(webpageId, source.id, userId, text, sourceName).catch(err => {
            log.error(`[Webpages] Text ingestion failed:`, err.message);
        });
    });

    router.post('/:id/sources/drive', requireAuth, validate({ body: DriveBody, query: NO_QUERY }), async (req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const webpageId = req.params.id;
        const { files, provider } = req.body;

        const wp = await webpageStore.getWebpage(webpageId, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sources = [];
        for (const file of files) {
            const type = provider === 'microsoft' ? 'onedrive' : 'gdrive';
            const source = await webpageStore.addSource({
                webpageId,
                type,
                name: file.name || 'Drive file',
                metadata: {
                    provider,
                    driveFileId: file.driveFileId,
                    charCount: file.content?.length,
                },
                wordCount: file.content ? file.content.split(/\s+/).length : 0,
            });
            sources.push(source);

            if (file.content) {
                ingestDriveSource(webpageId, source.id, userId, file.content, file.name).catch(err => {
                    log.error(`[Webpages] Drive ingestion failed for ${log.nameForLog(file.name)}:`, err.message);
                });
            } else {
                webpageStore.updateSource(source.id, { status: 'error', error: 'No content received from Drive' });
            }
        }

        res.json({ success: true, sources });
    });

    router.get('/:id/sources', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const sources = await webpageStore.getSources(wp.id);
        let finalSources = sources;
        if (sources.some(s => s.status === 'processing')) {
            const timedOut = await webpageStore.timeoutStuckSources(wp.id).catch(() => 0);
            if (timedOut > 0) finalSources = await webpageStore.getSources(wp.id);
        }
        res.json({ sources: finalSources, managed: await webpageStore.managedPayloadOf(wp) });
    });

    router.post('/:id/sources/:sid/retry', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, sid: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, { status: 'processing', error: null });
        res.json({ success: true });

        (async () => {
            try {
                if (source.type === 'url') {
                    const url = source.metadata?.url;
                    if (!url) throw new Error('Source has no URL to retry');
                    await ingestUrlSource(wp.id, source.id, userId, url);
                } else if (source.storageKey) {
                    if (!storageStore.isAvailable()) throw new Error('Storage not configured');
                    const { stream } = await storageStore.streamFile(source.storageKey);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    const mimeType = source.metadata?.mimeType || 'application/octet-stream';
                    await ingestFileSource(wp.id, source.id, userId, buffer, source.fileName || source.name, mimeType);
                } else {
                    throw new Error('This source type cannot be retried — please re-add it.');
                }
            } catch (e) {
                log.error(`[Webpages] Retry failed for source ${source.id}:`, /** @type {Error} */ (e).message);
                await webpageStore.updateSource(source.id, { status: 'error', error: /** @type {Error} */ (e).message }).catch((e) => bestEffort('routes/webpages/sources:register', e));
            }
        })();
    });

    router.post('/:id/sources/:sid/cancel', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, sid: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const source = await webpageStore.getSource(req.params.sid);
        if (!source || source.webpageId !== wp.id) return res.status(404).json({ error: 'Source not found' });

        await webpageStore.updateSource(source.id, {
            status: 'error',
            error: 'Cancelled by user',
        });
        res.json({ success: true });
    });

    router.delete('/:id/sources/:sid', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, sid: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Scope the delete to THIS webpage so a foreign source id can't be
        // removed (and its RustFS blob purged) via a webpage the caller owns.
        // Mirrors the ownership check the retry/cancel routes already do.
        const source = await webpageStore.deleteSource(req.params.sid, wp.id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        if (source.storageKey) {
            try {
                if (!source.storageKey.startsWith('local:')) {
                    await storageStore.deleteFile(source.storageKey);
                }
            } catch (e) { log.warn('[Webpages] Storage cleanup:', /** @type {Error} */ (e).message); }
        }

        const kbIds = wp.knowledgeBaseIds || [];
        for (const kbId of kbIds) {
            try {
                const doc = await findDocumentBySourceUri(kbId, source.id);
                if (doc) await deleteDocumentChunks(kbId, doc.id, userId);
            } catch (e) {
                log.warn(`[Webpages] KB chunk cleanup for ${source.id}:`, /** @type {Error} */ (e).message);
            }
        }

        res.json({ success: true });
    });
}

module.exports = { register };
