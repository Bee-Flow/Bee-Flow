// @typecheck strict
/**
 * De extra bestanden van een multi-file project, en de binaire assets ernaast.
 *
 * GET/PUT/DELETE /:id/files  ·  POST /:id/assets  ·  POST /:id/assets/move
 */

const webpageStore = require('../../stores/webpageStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const { reSnapshotWebpageShares } = require('./publicShares');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded, bodyOf, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');
const { sessionUser } = require('../../core/http/sessionUser');

// ── What the file routes may carry ─────────────────────────────────
//
// The PATH is the key in all four cases, and `?paht=src/App.jsx` returned the LIST instead
// of a 400 — a client that thought it was reading a file got a table of contents. Strict
// on the query makes that a question that is either answered or refused.
//
// What a path MAY be stays with the store: upsertExtraFile refuses reserved paths, `..`
// steps and the primary slots by name, and those rules belong to the storage, not to the
// HTTP layer.
const PATH_TEXT = 'path is required';
const pathText = () => worded(PATH_TEXT).trim().min(1, PATH_TEXT);
const FileQuery = z.object({ path: pathText().optional() }).strict();
const PathQuery = z.object({ path: pathText() }).strict();

const PutFileBody = bodyOf({
    path: pathText(),
    content: worded('content is required (string)'),
});

const MoveBody = bodyOf({
    from: pathText(),
    to: pathText(),
});

// The text fields beside the file. FormData carries only text, and this is the
// only field the editor sends along.
const AssetBody = bodyOf({ path: pathText() });

/**
 * @param {import('express').Router} router
 * @param {import('./index').WebpageRouteDeps} deps shared multipart gate (`upload`)
 */
function register(router, { upload }) {
    // ── Extra files (multi-file projects) ────────────────────────────────
    // Read content of one extra file. Used by the frontend to fetch the bytes
    // for the live preview and the file-explorer detail view.
    router.get('/:id/files', requireAuth, validate({ query: FileQuery }), /** @param {import('express').Request<{ id: string }, unknown, unknown, { path?: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        // Owner OR org/group-published reader — same visibility as GET /:id, so
        // shared-page viewers can load the React src/ files their preview needs.
        let wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) {
            const raw = await webpageStore.getWebpageRaw(req.params.id);
            const { orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            if (raw && await webpageStore.canReadWebpageAsync(raw, userId, userGroups, orgIdArr)) {
                wp = raw;
            }
        }
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        // Extra-file bytes live under the OWNER's RustFS prefix, not the caller's.
        const ownerId = wp.userId;
        const path = req.query.path;
        const managed = await webpageStore.managedPayloadOf(wp);
        if (path === undefined) {
            const list = await webpageStore.listExtraFiles(req.params.id);
            return res.json({ files: list, managed });
        }
        const file = await webpageStore.readExtraFile({ webpageId: req.params.id, userId: ownerId, path });
        if (!file) return res.status(404).json({ error: 'File not found' });
        if (file.meta.isText) {
            return res.json({ meta: file.meta, content: file.text, managed });
        }
        // Binary: return base64 so the frontend can build a data URL.
        return res.json({ meta: file.meta, contentBase64: file.bytes.toString('base64'), managed });
    });

    // Upsert content of one extra text file. Owner-only — read-only viewers
    // must keep using the AI tools to mutate files.
    router.put('/:id/files', requireAuth, validate({ body: PutFileBody, query: NO_QUERY }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        try {
            const userId = sessionUser(req).id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
            const { path, content } = req.body;
            const file = await webpageStore.upsertExtraFile({
                webpageId: req.params.id,
                userId,
                path,
                content,
            });
            // React-mui apps live in extra files, so refresh public-share snapshots.
            reSnapshotWebpageShares(req.params.id, userId);
            // …and for exactly the same reason, the dependents index: a react-mui page has its table
            // elements in `src/App.jsx`, not in the html slot.
            webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);
            res.json({ file });
        } catch (err) {
            // A refusal worded for the caller (409 managed_part) keeps its status and code.
            if (err?.status && err.status < 500) throw err;
            // upsertExtraFile validates the path and surfaces clear messages
            // (reserved paths, traversal attempts) — pass those through as 400s.
            const status = /^(Reserved|Invalid|Path)/i.test(err.message) ? 400 : 500;
            if (status === 500) log.error('[Webpages] Put extra file failed:', err);
            res.status(status).json({ error: err.message || 'Failed to save file' });
        }
    });

    // Delete one extra file. Owner-only.
    router.delete('/:id/files', requireAuth, validate({ query: PathQuery }), /** @param {import('express').Request<{ id: string }, unknown, unknown, { path: string }>} req @param {import('express').Response} res */ async (req, res) => {
        const userId = sessionUser(req).id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });
        if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
        const ok = await webpageStore.deleteExtraFile({ webpageId: req.params.id, userId, path: req.query.path });
        if (!ok) return res.status(404).json({ error: 'File not found' });
        reSnapshotWebpageShares(req.params.id, userId);
        // A discarded file is the side where the index silently goes WRONG: otherwise the row of
        // the table that stood only there stays forever.
        webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);
        res.json({ success: true });
    });

    // Upload a BINARY asset (image, font, audio, …) as an extra file. Multipart so
    // raw bytes never round-trip through JSON/base64 in the request. Owner-only.
    // Returns the file meta + base64 content so the client can build a data: URL
    // for the preview without a follow-up GET. The store derives the MIME from the
    // path extension and stores it as a binary (is_text=false) extra.
    // Multipart, so the schema sits BEHIND multer: that reads the stream and only
    // then fills `req.body` (the file goes to `req.file`). A validate() in front of
    // it would see an empty body.
    router.post('/:id/assets', requireAuth, validate({ query: NO_QUERY }), upload.single('file'),
        validate({ body: AssetBody }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        try {
            const userId = sessionUser(req).id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            const { path } = req.body;
            const file = await webpageStore.upsertBinaryExtraFile({
                webpageId: req.params.id,
                userId,
                path,
                buffer: req.file.buffer,
                mimeType: req.file.mimetype,
            });
            // Binary assets are inlined into the react bundle, so refresh snapshots.
            reSnapshotWebpageShares(req.params.id, userId);
            res.json({ file, contentBase64: req.file.buffer.toString('base64') });
        } catch (err) {
            // A refusal worded for the caller (409 managed_part) keeps its status and code.
            if (err?.status && err.status < 500) throw err;
            const status = /(primary slot|relative|may not|contains|too long|required|empty|segment)/i.test(err.message) ? 400 : 500;
            if (status === 500) log.error('[Webpages] Asset upload failed:', err);
            res.status(status).json({ error: err.message || 'Failed to upload asset' });
        }
    });

    // Move/rename an extra file server-side (text OR binary) without round-tripping
    // bytes through the client. Owner-only. Reads the source, writes it at the new
    // path, then deletes the source.
    router.post('/:id/assets/move', requireAuth, validate({ body: MoveBody, query: NO_QUERY }), /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res */ async (req, res) => {
        try {
            const userId = sessionUser(req).id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });
            if (wp.userId !== userId) return res.status(403).json({ error: 'Read-only' });
            const { from, to } = req.body;
            if (from === to) return res.status(400).json({ error: 'from and to are identical' });
            const existingDest = await webpageStore.getExtraFile(req.params.id, to);
            if (existingDest) return res.status(409).json({ error: `A file already exists at "${to}"` });
            const src = await webpageStore.readExtraFile({ webpageId: req.params.id, userId, path: from });
            if (!src) return res.status(404).json({ error: 'Source file not found' });
            let file;
            if (src.meta.isText) {
                file = await webpageStore.upsertExtraFile({ webpageId: req.params.id, userId, path: to, content: src.text });
            } else {
                file = await webpageStore.upsertBinaryExtraFile({
                    webpageId: req.params.id, userId, path: to, buffer: src.bytes, mimeType: src.meta.mimeType,
                });
            }
            await webpageStore.deleteExtraFile({ webpageId: req.params.id, userId, path: from });
            reSnapshotWebpageShares(req.params.id, userId);
            // A move does not change the CONTENT, so the table list stays the same — but that is
            // reasoning about an implementation detail (`source` is only a label in the scan), and
            // an exception to "every path that records files" is exactly how such a list drifts.
            webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);
            res.json({ file });
        } catch (err) {
            // A refusal worded for the caller (409 managed_part) keeps its status and code.
            if (err?.status && err.status < 500) throw err;
            const status = /(primary slot|relative|may not|contains|too long|required|empty|segment)/i.test(err.message) ? 400 : 500;
            if (status === 500) log.error('[Webpages] Asset move failed:', err);
            res.status(status).json({ error: err.message || 'Failed to move file' });
        }
    });
}

module.exports = { register };
