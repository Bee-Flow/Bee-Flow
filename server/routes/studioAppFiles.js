/**
 * App Studio v2 — ATTACHMENT upload/stream router.
 *
 * Mounted at /api/studio-apps ALONGSIDE studioApps.js / studioAppsRun.js /
 * studioAppData.js (Express allows multiple routers per path). Session-auth —
 * App Studio runs inside the SPA, there is NO preview token here.
 *
 * Endpoints:
 *   POST   /:id/data/attachments          — upload a file (guard → quota → scan)
 *   GET    /:id/data/attachments/:fileId  — stream a file (read-access re-checked)
 *   DELETE /:id/data/attachments/:fileId  — discard an UNLINKED upload
 *
 * ── SECURITY MODEL (mirrors studioAppData.js / studioAppsRun.js) ─────
 *   • App visibility: owner always; else is_published + canReadStudioApp. Every
 *     not-visible / not-found answer is a uniform 404 — existence never leaks.
 *   • Blobs live under the app OWNER's storage prefix (acts-as-owner storage
 *     identity); the attachment ledger is owner-scoped, so a fileId from another
 *     app can never resolve here (foreign app → 404, IDOR-proof).
 *   • Upload is a WRITE: the owner, or a viewer whose RLS role may create/update
 *     somewhere in the app. A read-only audience may look, never attach.
 *   • Upload is a QUARANTINE flow: validate (uploadGuard) → permission → quota
 *     (file count, per-file bytes AND the app's total attachment bytes) → put
 *     the blob → scan; only a CLEAN scan writes the ledger row (scanned:true). A
 *     dirty scan deletes the blob and answers 422 — the bytes are never linked.
 *   • Download RE-CHECKS the viewer may read a record the attachment hangs off
 *     (rlsGateway + queryCompiler), then streams via the store — never a public
 *     presigned URL.
 *
 * ── What a caller may send ───────────────────────────────────────────
 * Every path param and query is `.strict()`, and so is the materialize body.
 * The upload's body is multipart: the FILE stays the guard's (uploadGuard
 * caps, sniffs and sanitises it, and answers its own 400/413/415), and only
 * its two optional text fields get a schema, checked after the guard parsed
 * them. The params and query are checked BEFORE the guard, so a malformed
 * request is refused without first reading a file into memory. What changed,
 * each of it silent under a 200 before:
 *   • `recordId` over 200 characters was cut to 200, linking the file to a
 *     record id that does not exist; `fieldKey` likewise at 100. Sent twice,
 *     multer made either an array, and the file landed unlinked (null).
 *   • `materialize {"attachmentId": …, "tableID": "t1"}` — or a `tableId` that
 *     was not text — dropped the narrowing and probed every readable table; an
 *     attachmentId that was a number was answered "attachmentId is required".
 *   • A query parameter on any of these (`?download=1`) was ignored.
 */

const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const router = express.Router();

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const storageStore = require('../stores/storageStore');
const { renderCadSheet } = require('../core/cad/cadRender');
const { renderDxfSheet } = require('../core/cad/dxfRender');
const { canonicalCadMime } = require('../core/cad/cadTypes');
const rlsGateway = require('../appStudio/rlsGateway');
const attachmentAccess = require('../appStudio/attachmentAccess');
const studioAppQuota = require('../appStudio/studioAppQuota');
const mailboxAttachments = require('../appStudio/mailboxAttachments');
const { uploadGuard, scanBuffer } = require('../middleware/uploadGuard');
const { DATA_LIMITS } = require('../appStudio/dataModel');
const { resolveAudienceContext } = require('../auth/audience');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

// ── Auth ────────────────────────────────────────────────────────────
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// ── Rate limits (per viewer + app) ──────────────────────────────────
const FILE_UPLOAD_RPM = parseInt(process.env.STUDIO_APP_FILE_UPLOAD_RPM, 10) || 20;
const FILE_READ_RPM = parseInt(process.env.STUDIO_APP_FILE_READ_RPM, 10) || 120;
function fileKey(req) {
    return `${req.session?.user?.id || 'anon'}:${req.params?.id || 'unknown'}`;
}
const uploadLimiter = perUserRateLimit({ windowMs: 60_000, max: FILE_UPLOAD_RPM, keyFn: fileKey });
const readLimiter = perUserRateLimit({ windowMs: 60_000, max: FILE_READ_RPM, keyFn: fileKey });

// The upload guard: cap at the per-attachment byte ceiling, allow the default
// image/pdf/csv/office set, sniff magic bytes, sanitize SVG.
const guard = uploadGuard({ maxBytes: DATA_LIMITS.MAX_ATTACHMENT_BYTES });

// ── What a caller may send ──────────────────────────────────────────
/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** An object that also accepts nothing at all: no body, or a test's bare req, reads as {}. */
const partOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const APP_ID_TEXT = 'The app id is the id in the app\'s address.';
const FILE_ID_TEXT = 'The file id is the id in the file\'s address.';
const appIdParam = worded(APP_ID_TEXT).min(1, APP_ID_TEXT).max(200, APP_ID_TEXT);
const fileIdParam = worded(FILE_ID_TEXT).min(1, FILE_ID_TEXT).max(200, FILE_ID_TEXT);

const NoQuery = partOf({});
const AppParams = z.object({ id: appIdParam }).strict();
const FileParams = z.object({ id: appIdParam, fileId: fileIdParam }).strict();

const RECORD_TEXT = 'recordId is the id of the record the file belongs to: text of at most 200 characters, sent once.';
const FIELD_TEXT = 'fieldKey is the key of the file field: text of at most 100 characters, sent once.';
// The text fields beside the file. The one client (AppInputFile) sends
// neither; the ledger's record link and field key are both optional.
const UploadFields = partOf({
    recordId: worded(RECORD_TEXT).max(200, RECORD_TEXT).optional(),
    fieldKey: worded(FIELD_TEXT).max(100, FIELD_TEXT).optional(),
});

const ATTACHMENT_TEXT = 'attachmentId is the id of the mail attachment to open.';
const TABLE_NARROW_TEXT = 'tableId narrows the search to one table: its id, as text.';
const RECORD_NARROW_TEXT = 'recordId narrows the search to one record: its id, as text.';
const MaterializeBody = partOf({
    // A mail provider's id; Gmail's run to several hundred characters.
    attachmentId: worded(ATTACHMENT_TEXT).min(1, ATTACHMENT_TEXT).max(4096, ATTACHMENT_TEXT),
    // Both only narrow the probe; the row is found under the viewer's own access.
    tableId: worded(TABLE_NARROW_TEXT).max(200, TABLE_NARROW_TEXT).nullish(),
    recordId: worded(RECORD_NARROW_TEXT).max(200, RECORD_NARROW_TEXT).nullish(),
});

// ── Audience helper (collapse Sets/null to a plain array) ───────────
async function audienceFor(req) {
    const { orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return { orgIdArr, userGroups: Array.isArray(userGroups) ? userGroups : [] };
}

// Owner always; else published + org/group/project audience
// (canReadStudioAppAsync). Failure answers 404.
async function loadVisibleApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (app.userId !== userId) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

// The app's data model + the viewer's RLS role in it (null when the app has no
// model — attachments are then owner-only, on both the write and the read side).
async function viewerRoleFor(req, app) {
    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = meta && meta.model && typeof meta.model === 'object' ? meta.model : null;
    if (!model || !Array.isArray(model.tables)) return { model: null, role: null };
    const { userGroups } = await audienceFor(req);
    const role = await rlsGateway.resolveViewerRole(app, req.session.user.id, model, { userGroups });
    return { model, role: role || null };
}

// Uploading is a WRITE — the bytes land in the OWNER's storage envelope. The
// owner always may; any other viewer needs a role that can create or update
// somewhere in the app, so a read-only audience can never fill it up. The rule
// itself lives in attachmentAccess.roleMayWriteSomewhere — shared with the
// dataset uploader so the two paths cannot drift.
async function viewerMayUpload(req, app) {
    if (app.userId === req.session.user.id) return true;
    const { model, role } = await viewerRoleFor(req, app);
    if (!model) return false;
    return attachmentAccess.roleMayWriteSomewhere(model, role);
}

// The app's total-bytes ceiling. One implementation, in mailboxAttachments —
// the mail path has to charge against exactly the same budget as an upload, and
// two copies of a quota rule is two different budgets waiting to happen.
const { assertAttachmentTotalBytes } = mailboxAttachments;

// Storage key for an attachment blob — content-addressed under the OWNER's
// prefix, reconstructable from the ledger row (owner + app + sha256). Shared
// builder in storageStore so the app-trigger bridge mints the same keys.
function attachmentKey(ownerId, appId, sha256) {
    return storageStore.buildStudioAppAttachmentKey(ownerId, appId, sha256);
}

// ── POST /:id/data/attachments ──────────────────────────────────────
router.post('/:id/data/attachments', requireAuth, uploadLimiter, validate({ params: AppParams, query: NoQuery }), guard,
    validate({ body: UploadFields }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        if (!(await viewerMayUpload(req, app))) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const file = req.file; // guard guarantees a validated, in-memory buffer
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'File storage is not available' });
        }

        // Quota BEFORE we persist any bytes.
        try {
            await studioAppQuota.assertAttachmentQuota(app, file.size);
            await assertAttachmentTotalBytes(app, file.size);
        } catch (err) {
            if (err && err.status === 409) {
                return res.status(409).json({ error: err.message, code: err.code, limit: err.limit, used: err.used });
            }
            throw err;
        }

        const recordId = req.body.recordId || null;
        const fieldKey = req.body.fieldKey || null;

        const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const key = attachmentKey(app.userId, app.id, sha);

        // Put the blob, THEN scan. A dirty verdict deletes it and 422s — the
        // ledger row is only written on a clean scan, so the bytes are never
        // linked to a record.
        await storageStore.uploadFile(key, file.buffer, file.mimetype, file.sanitized ? { sanitized: 'true' } : null);

        const scan = await scanBuffer(file.buffer);
        if (!scan.clean) {
            try { await storageStore.deleteFile(key); } catch (_) { /* best-effort cleanup */ }
            return res.status(422).json({ error: 'File failed a malware scan', signature: scan.signature || null });
        }

        const attachment = await studioAppDataStore.addAttachment(app.id, app.userId, {
            recordId,
            fieldKey,
            mimeType: file.mimetype,
            sha256: sha,
            size: file.size,
        });
        // scanned:true — the row exists only because the scan passed.
        await studioAppDataStore.setAttachmentScan(attachment.id, app.id, app.userId, { scanned: true, quarantined: false })
            .catch(() => { /* advisory */ });

        res.json({
            success: true,
            attachment: {
                id: attachment.id,
                recordId: attachment.recordId,
                fieldKey: attachment.fieldKey,
                mime: attachment.mimeType,
                size: attachment.size,
                sha: attachment.sha256,
                scanned: true,
            },
        });
    } catch (err) {
        log.error(`[StudioAppFiles/upload] ${err.message}`);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Can this viewer read a record the attachment hangs off? The rule itself lives
// in appStudio/attachmentAccess.js because the AI path needs the SAME answer and
// used not to ask the question at all — see that file's header.
async function viewerMayReadAttachment(req, app, attachment) {
    const viewerId = req.session.user.id;
    if (app.userId === viewerId) return true;
    const { model, role } = await viewerRoleFor(req, app);
    return attachmentAccess.viewerMayReadAttachment(app, attachment, {
        id: viewerId,
        role,
        model,
        organizationId: req.session.user.organizationId || null,
    });
}

// ── GET /:id/data/attachments/:fileId ───────────────────────────────
router.get('/:id/data/attachments/:fileId', requireAuth, readLimiter, validate({ params: FileParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;

        // Owner-scoped fetch: a fileId from another app (or owner) → null → 404.
        const attachment = await studioAppDataStore.getAttachment(req.params.fileId, app.id, app.userId);
        if (!attachment || attachment.quarantined) {
            return res.status(404).json({ error: 'Attachment not found' });
        }

        const allowed = await viewerMayReadAttachment(req, app, attachment);
        if (!allowed) return res.status(404).json({ error: 'Attachment not found' });

        const key = attachmentKey(app.userId, app.id, attachment.sha256);
        let obj;
        try {
            obj = await storageStore.streamFile(key);
        } catch (err) {
            if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
                return res.status(404).json({ error: 'Attachment not found' });
            }
            throw err;
        }

        const mime = attachment.mimeType || obj.contentType || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Inline only for types that are safe to render (SVG was sanitized at
        // upload); everything else is forced to download.
        const inline = /^image\//.test(mime) || mime === 'application/pdf';
        res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
        if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);

        obj.stream.on('error', (e) => {
            log.error(`[StudioAppFiles/stream] ${e.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
            else res.destroy();
        });
        obj.stream.pipe(res);
    } catch (err) {
        log.error(`[StudioAppFiles/get] ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to load attachment' });
    }
});

// ── GET /:id/data/attachments/:fileId/preview ───────────────────────
//
// A rendered picture of a 3D file, so a .step stops being a dead end in the one
// place people look at their files. The response is an ordinary PNG, which is
// why the preview component needed no new capability to show it — and why the
// same bytes can be handed to a vision model that cannot read B-rep.
//
// RENDERED ON FIRST ASK, NOT AT INTAKE. Most attachments on an order are never
// opened; tesselating all of them up front spends CPU and storage on pictures
// nobody looks at. The result is cached under the app's own object tree, so the
// second viewer — and the AI's later check — pay nothing.
//
// The cache key carries a renderer VERSION: improving the renderer must not
// leave every existing part showing the old picture forever.
const CAD_VIEW_VERSION = 'v2';
// The 2D renderer is a different program with its own output, so it carries
// its own version rather than sharing the 3D one — bumping either must not
// invalidate the other's cached sheets.
const DXF_VIEW_VERSION = 'v1';

router.get('/:id/data/attachments/:fileId/preview', requireAuth, readLimiter, validate({ params: FileParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;

        // Same three gates as the raw stream, in the same order: a rendered
        // picture of a file is still the file, so it may not be reachable by
        // anyone who could not have downloaded it.
        const attachment = await studioAppDataStore.getAttachment(req.params.fileId, app.id, app.userId);
        if (!attachment || attachment.quarantined) return res.status(404).json({ error: 'Attachment not found' });
        if (!(await viewerMayReadAttachment(req, app, attachment))) return res.status(404).json({ error: 'Attachment not found' });

        // The ledger row IS the answer: every path that stores a file
        // canonicalises the type on the way in (mailboxAttachments derives it
        // with cadMimeForName before it ever writes a row), so a second guess
        // here has nothing left to add.
        //
        // It also never ran. The fallback read `attachment.fileName`, and there
        // is no such column and no such field on mapAttachmentRow — so it was
        // always `cadMimeForName('')`, always null, for as long as it has
        // existed. Dead code that LOOKS like a safety net is worse than no net:
        // it is why nobody noticed that an octet-stream CAD file has only ever
        // been answered by the honest 415 below.
        const mime = canonicalCadMime(attachment.mimeType || '');
        // Two renderers behind one endpoint. A .step is a solid and gets four
        // shaded views; a .dxf is flat cutting geometry and gets one drawing.
        // Both come back as a PNG, so the caller needs to know neither.
        const format = mime === 'model/iges' ? 'iges'
            : (mime === 'model/step' ? 'step'
                : (mime === 'image/vnd.dxf' ? 'dxf' : null));
        if (!format) {
            // Honest 415 rather than a broken image: the preview component
            // shows the reason and still offers the download.
            return res.status(415).json({ error: 'No preview for this file type' });
        }

        const viewKey = format === 'dxf'
            ? `${attachmentKey(app.userId, app.id, attachment.sha256)}.dxfview-${DXF_VIEW_VERSION}.png`
            : `${attachmentKey(app.userId, app.id, attachment.sha256)}.cadview-${CAD_VIEW_VERSION}.png`;

        const sendPng = (obj) => {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Disposition', 'inline');
            // Immutable: the key already contains the file's hash AND the
            // renderer version, so these bytes can never change meaning.
            res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
            obj.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
            obj.stream.pipe(res);
        };

        try {
            return sendPng(await storageStore.streamFile(viewKey));
        } catch (err) {
            if (err?.name !== 'NoSuchKey' && err?.$metadata?.httpStatusCode !== 404) throw err;
        }

        // Cache miss — render it now.
        let source;
        try {
            source = await storageStore.streamFile(attachmentKey(app.userId, app.id, attachment.sha256));
        } catch (err) {
            if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
                return res.status(404).json({ error: 'Attachment not found' });
            }
            throw err;
        }
        const chunks = [];
        for await (const chunk of source.stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        let png;
        try {
            ({ png } = format === 'dxf'
                ? await renderDxfSheet(buffer, { name: attachment.fileName || '' })
                : await renderCadSheet(buffer, { format }));
        } catch (err) {
            // A renderer refusing a file is a normal outcome, not a server
            // fault — some STEP files carry no solid geometry at all, and a
            // binary DXF has no group codes to read.
            log.warn(`[StudioAppFiles/cadPreview] ${attachment.fileName}: ${err.message}`);
            return res.status(415).json({ error: 'This file could not be drawn' });
        }

        // Best-effort cache: a storage hiccup must not turn a working preview
        // into an error, it should only make the next viewer render again.
        try {
            await storageStore.uploadFile(viewKey, png, 'image/png');
        } catch (err) {
            log.warn(`[StudioAppFiles/cadPreview] could not cache ${viewKey}: ${err.message}`);
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
        return res.send(png);
    } catch (err) {
        log.error(`[StudioAppFiles/cadPreview] ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to render this file' });
        return undefined;
    }
});

// ── DELETE /:id/data/attachments/:fileId ────────────────────────────
//
// Discard an upload the user changed their mind about. The X on a file input
// only dropped the descriptor from the field value; the bytes stayed forever,
// with no route that could ever remove them, so three wrong picks left three
// dead 8 MB blobs charging against the app's storage quota and the only visible
// symptom was later uploads failing with "file storage is full".
//
// Deliberately narrow, because the ledger records the app OWNER and not the
// uploader — there is no "my upload" to scope to:
//   • Only an attachment with NO recordId may go. Once it hangs off a record it
//     is that record's data; removing it here would silently gut a row.
//   • The caller must be someone who may upload at all (the owner, or a viewer
//     whose role can create/update) — the same gate the POST uses.
//   • The blob only goes when it was the last ledger row for those bytes:
//     storage is content-addressed, so identical files share one object.
router.delete('/:id/data/attachments/:fileId', requireAuth, uploadLimiter, validate({ params: FileParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        if (!(await viewerMayUpload(req, app))) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const attachment = await studioAppDataStore.getAttachment(req.params.fileId, app.id, app.userId);
        if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
        if (attachment.recordId) {
            return res.status(409).json({
                error: 'This file is attached to a record — remove it from the record instead.',
                code: 'attachment_linked',
            });
        }

        await studioAppDataStore.deleteAttachment(attachment.id, app.id, app.userId);

        const stillUsed = await studioAppDataStore.countAttachmentsBySha(app.id, app.userId, attachment.sha256);
        if (stillUsed === 0 && attachment.sha256 && storageStore.isAvailable()) {
            // Best-effort: the ledger row is already gone, so the bytes no
            // longer count as used space either way — an orphan object is a
            // storage-sweep problem, not a correctness one.
            try { await storageStore.deleteFile(attachmentKey(app.userId, app.id, attachment.sha256)); } catch (_) { /* swept later */ }
        }

        res.json({ success: true });
    } catch (err) {
        log.error(`[StudioAppFiles/delete] ${err.message}`);
        res.status(500).json({ error: 'Failed to remove the file' });
    }
});

// ── POST /:id/data/attachments/materialize ──────────────────────────
//
// Redeem a mail attachment for a real file. This IS an upload — third-party
// bytes land in the owner's storage envelope — so it shares uploadLimiter and
// the same quota + scan gates, and mailboxAttachments does the authorisation
// (the row must be readable by this viewer) before any provider call.
router.post('/:id/data/attachments/materialize', requireAuth, uploadLimiter,
    validate({ params: AppParams, query: NoQuery, body: MaterializeBody }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;

        // Only the provider's attachment id is required: the row it lives in is
        // found server-side under the viewer's own read access (a pending
        // descriptor is written before its row has an id, so the client cannot
        // name it — and trusting a client-named record would be worse anyway).
        const { attachmentId, tableId, recordId } = req.body;

        const { model, role } = await viewerRoleFor(req, app);
        if (!model) return res.status(404).json({ error: 'Not found' });

        const descriptor = await mailboxAttachments.materializeAttachment(app, model, {
            attachmentId,
            tableId: tableId ?? undefined,
            recordId: recordId ?? undefined,
            viewer: {
                id: req.session.user.id,
                // The owner writes as the owner; anyone else keeps their role so
                // the RLS read is real.
                role: app.userId === req.session.user.id ? 'owner' : role,
                organizationId: req.session.user.organizationId || null,
            },
        });

        res.json({ success: true, attachment: descriptor });
    } catch (err) {
        if (err?.code === 'quota_exceeded') {
            return res.status(409).json({ error: err.message, code: err.code, limit: err.limit, used: err.used });
        }
        const status = Number.isInteger(err?.status) ? err.status : 500;
        // 5xx is ours and gets logged; a 4xx is the caller being told no.
        if (status >= 500) log.error(`[StudioAppFiles/materialize] ${err.message}`);
        res.status(status).json({ error: status >= 500 ? 'Failed to open attachment' : err.message });
    }
});

module.exports = router;
