/**
 * Project workspace routes — files, "my chats" and presence.
 *
 *   GET    /:id/files            viewer   the files uploaded into the project
 *   POST   /:id/files            editor   upload one file (multipart field `file`)
 *   DELETE /:id/files/:fileId    editor   remove one file and its search index
 *   GET    /:id/my-chats         viewer   the caller's own AI chats filed here
 *   POST   /:id/presence         viewer   "I am here" (transient presence.online)
 *
 * A FACTORY router: `makeWorkspaceRouter(deps)` takes every collaborator, so
 * its test serves it with fakes and no module mocking; the default export is
 * `makeWorkspaceRouter()` over the real modules. routes/projects.js mounts it
 * (`router.use('/', require('./projects/workspace'))`), behind the
 * /api/projects mount's session and licence gates.
 *
 * Every `/:id…` route starts with `requireProjectRole`: 404 for somebody who
 * is not a member (a project's existence is not probeable), 403 for a role
 * that is too low. Refusals are HttpErrors answered by the terminal handler.
 *
 * Where the files live and how they are processed: projects/projectFiles.js.
 */

'use strict';

const express = require('express');
const multer = require('multer');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { badRequest, conflict, notFound } = require('../../core/http/errors');
const S = require('./workspaceSchemas');

const MAX_FILE_MB = 20;

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]  (minRole) => middleware named requireProjectRoleMw
 * @param {Function} [deps.getProject]          (id) => project | null
 * @param {object}   [deps.projectFiles]        projects/projectFiles surface
 * @param {object}   [deps.myChats]             projects/myProjectChats surface ({ list })
 * @param {Function} [deps.logActivity]         projectStore.logActivity
 * @param {Function} [deps.emitProjectEvent]    core/projectFeed.emitProjectEvent
 * @param {Function} [deps.publishTransient]    core/projectEventBus.publishTransient
 * @param {Function} [deps.signalProjectChanged]  (project, reason) => void (routes/projects/complianceSignal)
 * @param {Function} [deps.uploadLimiter]       rate-limit middleware for uploads
 * @param {Function} [deps.presenceLimiter]     rate-limit middleware for presence pings
 * @param {number}   [deps.maxFileBytes]
 * @param {object}   [deps.log]
 */
function makeWorkspaceRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    // The real gate is required on first use, so loading this file (as the
    // default router does) does not load the auth and user stores with it.
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const projectFiles = () => deps.projectFiles || require('../../projects/projectFiles');
    const myChats = () => deps.myChats || require('../../projects/myProjectChats');
    const getProject = (id) => (deps.getProject || require('../../stores/projectStore').getProject)(id);
    const logActivity = (...a) => (deps.logActivity || require('../../stores/projectStore').logActivity)(...a);
    const emitProjectEvent = (...a) => (deps.emitProjectEvent || require('../../core/projectFeed').emitProjectEvent)(...a);
    const publishTransient = (...a) => (deps.publishTransient || require('../../core/projectEventBus').publishTransient)(...a);
    // The project's files are something the project compliance checks read.
    const filesChanged = (project) => (deps.signalProjectChanged || require('./complianceSignal').signalProjectChanged)(project, 'files');
    const log = deps.log || require('../../telemetry/log');
    const maxFileBytes = deps.maxFileBytes || require('../../projects/projectFiles').MAX_FILE_BYTES;

    const limiter = (opts) => require('../../utils/perUserRateLimit').perUserRateLimit(opts);
    // Uploads are the heavy call here: extraction, a privacy scan and
    // embedding per file. Named, so the ceiling holds across replicas.
    const uploadLimiter = deps.uploadLimiter
        || limiter({ windowMs: 60_000, max: 30, name: 'project-files' });
    // A page sends one ping every 30 s; this leaves room for several tabs and
    // stops a loop from turning presence into a flood.
    const presenceLimiter = deps.presenceLimiter || limiter({
        windowMs: 60_000, max: 20,
        keyFn: (req) => `${req.session?.user?.id || req.ip}:${req.params?.id || ''}`,
    });

    const upload = multer({
        storage: multer.memoryStorage(),
        // One file and nothing else: an unexpected field is a client bug, and
        // answering 201 to it would silently drop whatever it meant.
        limits: { fileSize: maxFileBytes, files: 1, fields: 0 },
        // File names in the part headers are UTF-8 in every current browser;
        // multer's latin1 default turns "Überblick.pdf" into mojibake.
        defParamCharset: 'utf8',
    }).single('file');

    /** Multer as middleware, with its refusals in sentences. */
    function acceptProjectFile(req, res, next) {
        upload(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') {
                // Answered here: the terminal handler words every 413 as a
                // generic "body too large", and this one has a limit to name.
                return res.status(413).json({ error: `A project file can be at most ${MAX_FILE_MB} MB.`, code: 'file_too_large' });
            }
            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                return next(badRequest('one_file', 'Upload one file at a time, in the form field "file".'));
            }
            if (err.code === 'LIMIT_FIELD_COUNT') {
                return next(badRequest('unexpected_field', 'A project file upload takes one form field: "file".'));
            }
            log.warn('[ProjectFiles] upload could not be read:', err.message);
            return next(badRequest('upload_failed', 'The upload could not be read. Try again.'));
        });
    }

    const userIdOf = (req) => req.session?.user?.id;

    /** The project behind a passed role gate; it can still vanish mid-request. */
    async function loadProject(req) {
        const project = await getProject(req.params.id);
        if (!project) throw notFound('not_found', 'Not found');
        return project;
    }

    /**
     * The audit row AND the live event, like routes/projects.js does it.
     * `details` holds ids and counts only: a file's NAME can be personal data
     * ("Sick note <name>.pdf"), and the activity row outlives the file. The
     * feed names a file when it is READ, while the file is still in the
     * project (projectFiles.nameFileActivity, used by GET /:id/activity).
     */
    async function logAndEmit(projectId, actorId, action, details) {
        await logActivity(projectId, actorId, action, details);
        await emitProjectEvent(projectId, {
            kind: action,
            actorId,
            targetType: details.targetType || null,
            targetId: details.targetId || null,
            payload: details,
        });
    }

    // ── Files ─────────────────────────────────────────────────────────

    router.get('/:id/files', requireRole('viewer'), validate({ query: S.FilesQuery }), async (req, res) => {
        const project = await loadProject(req);
        const { files, kbId } = await projectFiles().listFiles(project);
        res.json({ files, kbId });
    });

    router.post('/:id/files', requireRole('editor'), uploadLimiter, acceptProjectFile, async (req, res) => {
        const project = await loadProject(req);
        // A Solution is a builder's bundle; its knowledge is linked bases, and
        // its chats cannot be filed there, so nothing would ever search these.
        if (project.kind === 'solution') {
            throw conflict('SOLUTION_HOLDS_NO_FILES', 'A Studio Solution has no project files. Link a knowledge base to it instead.');
        }
        const file = req.file;
        if (!file || !file.buffer) throw badRequest('no_file', 'Choose a file to upload, in the form field "file".');
        if (!file.size && file.buffer.length === 0) throw badRequest('empty_file', 'This file is empty.');

        const userId = userIdOf(req);
        const added = await projectFiles().addFile(project, file, { userId });
        try {
            await logAndEmit(project.id, userId, 'file.added', { targetType: 'file', targetId: added.file.id });
        } finally {
            // Always processed, even when announcing it failed: a row left
            // "queued" for ever is worse than a missing activity line.
            added.start({
                onDone: async (status) => {
                    if (status === 'removed') return;
                    // Processed (scanned and indexed, or failed): now there is
                    // something new for the checks to read.
                    filesChanged(project);
                    try {
                        await publishTransient(project.id, {
                            kind: 'file.processed', actorId: userId,
                            targetType: 'file', targetId: added.file.id,
                            payload: { fileId: added.file.id, status },
                        });
                    } catch (_) { /* the list refetches on its next event either way */ }
                },
            });
        }
        res.status(201).json({ file: added.file });
    });

    router.delete('/:id/files/:fileId', requireRole('editor'),
        validate({ params: S.FileParams, query: S.NoQuery, body: S.NoBody }), async (req, res) => {
            const project = await loadProject(req);
            const userId = userIdOf(req);
            const removed = await projectFiles().removeFile(project, req.params.fileId, { userId });
            if (!removed) throw notFound('file_not_found', 'That file is not in this project.');
            await logAndEmit(project.id, userId, 'file.removed', { targetType: 'file', targetId: removed.id });
            filesChanged(project);
            res.json({ success: true });
        });

    // ── My chats ──────────────────────────────────────────────────────

    router.get('/:id/my-chats', requireRole('viewer'), validate({ query: S.MyChatsQuery }), async (req, res) => {
        const chats = await myChats().list(userIdOf(req), req.params.id, { limit: req.query.limit });
        res.json({ chats });
    });

    // ── Presence ──────────────────────────────────────────────────────

    // Transient: no row, no seq, no replay — a reconnecting client must never
    // be told somebody is here because they were ten minutes ago.
    router.post('/:id/presence', requireRole('viewer'), presenceLimiter, validate({ body: S.PresenceBody }), async (req, res) => {
        try {
            await publishTransient(req.params.id, { kind: 'presence.online', actorId: userIdOf(req) });
            res.json({ ok: true });
        } catch (err) {
            // Presence is decoration. Never fail a request over it.
            log.warn('[Projects] presence publish failed:', err.message);
            res.json({ ok: false });
        }
    });

    return router;
}

module.exports = makeWorkspaceRouter();
module.exports.makeWorkspaceRouter = makeWorkspaceRouter;
