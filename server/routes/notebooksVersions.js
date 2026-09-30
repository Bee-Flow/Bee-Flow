// @typecheck
/**
 * Notebook versions — the uniform version API (the same shape Studio
 * documents answer), mounted under /api/notebooks by routes/notebooks.js.
 *
 *   GET    /:id/versions?cursor=&limit=     viewer  → { versions, nextCursor }
 *   GET    /:id/versions/:ref               viewer  → { version: {…meta, content: {html, markdown}} }
 *                                                     (ref = a version id, or 'current')
 *   POST   /:id/versions {name}             editor  → 201 { version } — names the CURRENT state
 *                                                     (the newest version, when it already holds it)
 *   PUT    /:id/versions/:ref/name {name}   editor  → { version } (null clears the name)
 *   POST   /:id/versions/:ref/restore       editor  → { version, current }
 *   POST   /:id/versions/kept {html}        editor  → 201 { version } — keeps text the page
 *                                                     could not save as a 'conflict' version
 *   DELETE /:id/versions/:ref               owner   → { success: true }
 *
 * A version is the state AFTER a checkpoint. Naming and restoring read the
 * CURRENT document, which while co-editing is the live co-editing state, not
 * the row's mirror (agents/notebooks/notebookCollab.js). A restore first keeps
 * the current state as a `pre_restore` version, so a restore is itself undoable,
 * then writes the old state: through the co-editing engine when a session is
 * active (everyone's editor follows), otherwise as a compare-and-set write
 * (409 when someone saved in between). Nothing here logs or emits content.
 *
 * Every write (name, rename, restore, keep) copies or touches a full document
 * in a history that keeps named and restore rows for ever, so the writes share
 * one per-user rate limit, naming the state the newest version already holds
 * names that version (notebookStore.recordVersion), and kept text is capped at
 * the size a co-edited document may reach.
 */

'use strict';

const express = require('express');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { validate } = require('../core/http/validate');
const { z, bodyOf, queryOf, wholeNumber } = require('../core/http/schemaParts');
const { requireNotebookRole } = require('./notebooksAccess');

const NAME_TEXT = 'name is text of at most 80 characters.';
const name = z.string({ required_error: NAME_TEXT, invalid_type_error: NAME_TEXT }).max(80, NAME_TEXT);

const ListQuery = queryOf({
    cursor: z.string({ invalid_type_error: 'cursor is the nextCursor of the previous page.' })
        .regex(/^\d{1,9}$/, 'cursor is the nextCursor of the previous page.').optional(),
    limit: wholeNumber('limit is a whole number from 1 to 200.', { min: 1, max: 200 }).optional(),
}, 'The version list');
const NameBody = bodyOf({
    name: name.trim().min(1, 'A version needs a name.'),
}, 'Naming the current version');
const RenameBody = bodyOf({
    name: name.nullable(),
}, 'Renaming a version');
const KEPT_TEXT = 'html is the text to keep, as HTML.';
// The largest document co-editing holds (core/collab/limits.js): text a page
// could not save is never larger than the document it was typed into.
const MAX_KEPT_BYTES = require('../core/collab/limits').defaultLimits().maxDocBytes;
const KEPT_SIZE_TEXT = `html is at most ${Math.round(MAX_KEPT_BYTES / (1024 * 1024))} MB.`;
const KeptBody = bodyOf({
    html: z.string({ required_error: KEPT_TEXT, invalid_type_error: KEPT_TEXT })
        .refine((v) => v.trim().length > 0, KEPT_TEXT)
        .refine((v) => Buffer.byteLength(v, 'utf8') <= MAX_KEPT_BYTES, KEPT_SIZE_TEXT),
}, 'Keeping unsaved text');
const RestoreBody = bodyOf({
    expectedVersion: wholeNumber('expectedVersion is the whole-number version you loaded.').nullish(),
}, 'Restoring a version');

const restoreUnavailable = () => new HttpError(503, 'restore_unavailable', 'The notebook could not be restored right now. Nothing was changed; try again in a moment.');

/** What a list row carries: metadata only, never content. */
function versionMeta(/** @type {any} */ v) {
    return {
        id: v.id,
        seq: v.seq,
        source: v.source,
        name: v.name,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
        contributors: v.contributors,
        stats: v.stats,
        pinned: v.pinned,
        restoredFrom: v.restoredFrom || null,
        // The label rows from before named versions carry ("Auto-save", …).
        ...(v.source === 'legacy' && v.summary ? { summary: v.summary } : {}),
    };
}

/**
 * `collab` is the co-editing facade (null for none); every collaborator
 * defaults to the real module.
 *
 * @param {{
 *   store?: any,
 *   collab?: any,
 *   feed?: { contentChanged: (args: object) => Promise<void> },
 *   writeLimiter?: (req: any, res: any, next: Function) => void,
 * }} [deps]
 */
function makeNotebookVersionsRouter(deps = {}) {
    const store = deps.store || require('../stores/notebookStore');
    const notebookCollab = require('../agents/notebooks/notebookCollab');
    const collab = () => (deps.collab !== undefined ? deps.collab : notebookCollab.defaultFacade());
    const feed = deps.feed || require('../agents/notebooks/notebookFeed').makeNotebookFeed();
    const gate = (/** @type {'viewer'|'editor'|'owner'} */ min) => requireNotebookRole(min, { store });
    // One budget for every version write, per person. Named, so it holds
    // across replicas when Redis is there. Naming or restoring is a click;
    // this leaves room for a busy session and stops a loop.
    const writeLimiter = deps.writeLimiter || require('../utils/perUserRateLimit')
        .perUserRateLimit({ windowMs: 60_000, max: 30, name: 'notebook-version-write' });
    const router = express.Router();

    const actor = (/** @type {any} */ req) => req.session.user.id;
    const asContributor = (/** @type {string} */ userId) => [{ userId, kind: 'user' }];

    router.get('/:id/versions', validate({ query: ListQuery }), gate('viewer'), async (req, res) => {
        const q = /** @type {any} */ (req.query);
        const { versions, nextCursor } = await store.listVersions(req.params.id, { cursor: q.cursor || null, limit: q.limit || 50 });
        res.json({ versions: versions.map(versionMeta), nextCursor });
    });

    router.get('/:id/versions/:ref', gate('viewer'), async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        if (req.params.ref === 'current') {
            const current = await notebookCollab.readCurrentContent(nb, collab());
            return res.json({
                version: {
                    id: 'current', seq: null, source: 'current', name: null,
                    createdAt: nb.lastEditedAt || nb.updatedAt, createdBy: nb.lastEditedBy || null,
                    contributors: nb.lastEditedBy ? asContributor(nb.lastEditedBy) : [],
                    stats: null, pinned: false, restoredFrom: null,
                    // The compare-and-set counter a restore may pass back.
                    documentVersion: nb.version,
                    content: { html: current.html, markdown: current.markdown },
                },
            });
        }
        const v = await store.getNotebookVersion(nb.id, req.params.ref);
        if (!v) throw new HttpError(404, 'version_not_found', 'Version not found');
        res.json({ version: { ...versionMeta(v), content: { html: v.html, markdown: v.markdown } } });
    });

    router.post('/:id/versions', validate({ body: NameBody }), gate('editor'), writeLimiter, async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        const userId = actor(req);
        const current = await notebookCollab.readCurrentContent(nb, collab());
        if (!current.html.trim()) {
            throw new HttpError(400, 'notebook_empty', 'This notebook is empty, so there is nothing to name yet.');
        }
        const v = await store.recordVersion(nb.id, {
            html: current.html, markdown: current.markdown, source: 'named', name: req.body.name,
            createdBy: userId, contributors: asContributor(userId),
        });
        void feed.contentChanged({ projectId: nb.projectId, notebookId: nb.id, contributors: asContributor(userId), versionId: v.id, source: 'named' });
        res.status(201).json({ version: versionMeta(v) });
    });

    // Text the page could not save, kept before the page replaces it: typing
    // that went on after a save lost a race (the person then took the saved
    // version), or while a live session could not be joined. A 'conflict'
    // version like the copy the server keeps of a refused save, so nothing a
    // person typed is dropped without a copy in the history.
    router.post('/:id/versions/kept', validate({ body: KeptBody }), gate('editor'), writeLimiter, async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        const userId = actor(req);
        const v = await store.recordVersion(nb.id, {
            html: req.body.html, source: 'conflict', createdBy: userId, contributors: asContributor(userId),
        });
        res.status(201).json({ version: versionMeta(v) });
    });

    router.put('/:id/versions/:ref/name', validate({ body: RenameBody }), gate('editor'), writeLimiter, async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        const v = await store.nameVersion(nb.id, req.params.ref, req.body.name);
        if (!v) throw new HttpError(404, 'version_not_found', 'Version not found');
        if (v.name) {
            void feed.contentChanged({ projectId: nb.projectId, notebookId: nb.id, contributors: asContributor(actor(req)), versionId: v.id, source: 'named' });
        }
        res.json({ version: versionMeta(v) });
    });

    router.post('/:id/versions/:ref/restore', validate({ body: RestoreBody }), gate('editor'), writeLimiter, async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        const userId = actor(req);
        if (req.params.ref === 'current') throw new HttpError(400, 'version_is_current', 'The current state cannot be restored over itself.');
        const target = await store.getNotebookVersion(nb.id, req.params.ref);
        if (!target) throw new HttpError(404, 'version_not_found', 'Version not found');

        // What is there now, kept first: a restore is itself undoable.
        const facade = collab();
        const current = await notebookCollab.readCurrentContent(nb, facade);
        // Co-edited, but the live document could not be read (a key or the
        // converter unavailable): the row is only a mirror of it, and a write
        // there would be reported as a restore and then silently undone by the
        // engine's next materialisation. Refuse; nothing has changed yet.
        if (current.active && !current.live) throw restoreUnavailable();
        const pre = await store.recordVersion(nb.id, {
            html: current.html, markdown: current.markdown, source: 'pre_restore',
            createdBy: userId, contributors: nb.lastEditedBy ? asContributor(nb.lastEditedBy) : [],
        });

        const content = { html: target.html, markdown: target.markdown };
        let documentVersion = null;
        let live = { applied: false };
        if (current.live) {
            try {
                live = await notebookCollab.applyEdit(nb.id, { origin: 'restore', actorId: userId }, content, facade);
            } catch (err) {
                log.warn('[NotebookVersions] restore through co-editing failed', { notebookId: nb.id, error: /** @type {any} */ (err)?.message });
                throw restoreUnavailable();
            }
        }
        if (!live.applied) {
            const expectedVersion = Number.isFinite(req.body.expectedVersion) ? req.body.expectedVersion : nb.version;
            const w = await store.updateNotebookCas(nb.id, userId, {
                documentContent: target.html,
                ...(target.markdown != null ? { documentMd: target.markdown } : {}),
                expectedVersion,
            });
            if (w.conflict) {
                throw new HttpError(409, 'version_conflict', 'Someone saved this notebook a moment ago. Nothing was restored; look again and retry.', {
                    currentVersion: w.currentVersion ?? null,
                });
            }
            if (!w.ok) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');
            documentVersion = w.version ?? null;
        }

        const restored = await store.recordVersion(nb.id, {
            html: target.html, markdown: target.markdown, source: 'restore', restoredFrom: target.id,
            createdBy: userId, contributors: asContributor(userId),
        });
        void feed.contentChanged({ projectId: nb.projectId, notebookId: nb.id, contributors: asContributor(userId), versionId: restored.id, source: 'restore' });
        res.json({
            version: versionMeta(restored),
            current: {
                // null while co-editing: the engine's materialiser bumps the
                // counter; the editor follows the live document instead.
                version: documentVersion,
                html: target.html,
                markdown: target.markdown,
                preRestoreVersionId: pre.id,
                live: !!live.applied,
            },
        });
    });

    router.delete('/:id/versions/:ref', gate('owner'), async (req, res) => {
        const nb = /** @type {any} */ (req).notebook;
        const ok = await store.deleteVersion(req.params.ref, nb.id);
        if (!ok) throw new HttpError(404, 'version_not_found', 'Version not found');
        res.json({ success: true });
    });

    return router;
}

module.exports = makeNotebookVersionsRouter();
module.exports.makeNotebookVersionsRouter = makeNotebookVersionsRouter;
module.exports.versionMeta = versionMeta;
