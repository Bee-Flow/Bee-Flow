// @typecheck
/**
 * A Studio document's history: the uniform versions API every item with a
 * history answers (notebooks answer the same shape at /api/notebooks/:id).
 * Mounted by routes/studioDocuments.js at `/:id/versions`.
 *
 *   GET    /                    viewer   { versions, nextCursor, people }
 *   GET    /:ref                viewer   { version: {…meta, content: { html, markdown: null }} }  ref = id | 'current'
 *   POST   /            {name}  editor   { version }  names the current state
 *   PUT    /:ref/name   {name}  editor   { version }  null clears (at most 80 characters)
 *   POST   /:ref/restore        editor   { version, current, document }  {expectedVersion?}
 *   DELETE /:ref                owner    { success: true }  409 version_in_use for the current,
 *                                                          first or a pinned revision
 *
 * "viewer" is anybody who may read the document (its owner, a project member
 * of any role, a colleague for a team template); "editor" is who may change
 * it; a project viewer who tries is told so (403), a stranger learns nothing
 * (404). Every answer is ids, counts and the version's own content: the
 * contributors' NAMES come from `people`, resolved for the reader's own
 * organisation only.
 *
 * A PAGE edited live (server/core/collab) has its current state in the live
 * document, not the stored body: naming it or restoring over it goes through
 * the live layer, so the name is on what people see and the restore reaches
 * every open editor at once.
 *
 * A FACTORY: `makeDocumentVersionsRouter(deps)` takes its collaborators, and
 * its test serves it with fakes; the default export is over the real modules.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError, notFound, forbidden } = require('../../core/http/errors');
const { worded, bodyOf, queryOf, wholeNumber, z } = require('../../core/http/schemaParts');

const NAME_TEXT = 'name is the version\'s name, at most 80 characters, or null to clear it.';
const S = {
    list: queryOf({
        cursor: worded('cursor is the nextCursor of the previous page.').max(400, 'cursor is the nextCursor of the previous page.').optional(),
        limit: wholeNumber('limit is a whole number from 1 to 100.', { min: 1, max: 100 }).optional(),
    }, 'The version list'),
    create: bodyOf({ name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(80, NAME_TEXT) }, 'Naming this version'),
    name: bodyOf({ name: worded(NAME_TEXT).trim().max(80, NAME_TEXT).nullable() }, 'Naming a version'),
    restore: bodyOf({
        expectedVersion: worded('expectedVersion is the current revision you read.').max(200, 'expectedVersion is the current revision you read.').optional(),
        // The older editor's name for the same thing.
        expectedVersionId: worded('expectedVersionId is the current revision you read.').max(200, 'expectedVersionId is the current revision you read.').optional(),
    }, 'Restoring a version'),
};
const REF = /^(current|[\w-]{1,200})$/;

/**
 * @param {object} [deps]
 * @param {object} [deps.documents]       stores/documentStore surface
 * @param {Function} [deps.requireAuth]
 * @param {Function} [deps.hasPermission]
 * @param {Function} [deps.liveCollabFor]  (doc) => collab facade | null
 * @param {object} [deps.feed]             { recordContentChange }
 * @param {Function} [deps.describePeople]
 * @param {Function} [deps.sanitize]       body HTML → safe HTML
 * @param {Function} [deps.pinnedVersionIds] () => the document revisions a routine or an app pins
 */
function makeDocumentVersionsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const documents = () => deps.documents || require('../../stores/documentStore');
    // Looked up per request, so loading this router does not load the auth
    // and user stores, and a test's session gate is the one used.
    const requireAuth = deps.requireAuth || ((req, res, next) => require('../../auth/permissions').requireAuth(req, res, next));
    const hasPermission = (...a) => (deps.hasPermission || require('../../auth/permissions').hasPermission)(...a);
    const liveCollabFor = (doc) => (deps.liveCollabFor || require('../../core/documents/documentFeed').liveCollabFor)(doc);
    const feed = () => deps.feed || require('../../core/documents/documentFeed');
    const describePeople = (...a) => (deps.describePeople || require('../../core/documents/documentPeople').describePeople)(...a);
    const sanitize = (html) => (deps.sanitize || require('../../services/documentCompose').sanitizeDocumentBody)(html);
    // The revisions routines and apps pin, from their definitions: the same
    // list the retention job never prunes (jobs/documentVersionRetention.js).
    const pinnedVersionIds = () => (deps.pinnedVersionIds
        || (() => require('../../jobs/documentVersionRetention').listPinnedVersionIds(require('../../db').pool)))();

    const userIdOf = (req) => req.session.user.id;
    const orgIdOf = (req) => req.session.connectorOrgId || req.session.user.organizationId || null;
    const context = async (req) => ({ userId: userIdOf(req), isAdmin: await hasPermission(userIdOf(req), 'org_admin', req.session) });

    /** A store refusal worded for the caller, as an HttpError; anything else as it is. */
    const fromStore = (err) => {
        const status = Number(err?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
            const out = new HttpError(status, err.errorClass || 'document_invalid', err.message);
            if (err.conflict) Object.assign(out, { details: { conflict: err.conflict } });
            return out;
        }
        return err;
    };
    const checkRef = (req) => {
        if (!REF.test(String(req.params.ref || ''))) throw notFound('version_not_found', 'Version not found');
        return req.params.ref;
    };
    /** The document the caller may read, or 404. */
    const readable = async (req) => {
        const doc = await documents().getDocument(req.params.id, userIdOf(req));
        if (!doc) throw notFound('document_not_found', 'Document not found');
        return doc;
    };
    /** The document the caller may change: a project viewer is told so. */
    const writable = async (req) => {
        const doc = await readable(req);
        if (doc.projectRole === 'viewer') {
            throw forbidden('document_read_only', 'You can read this document, but only the project\'s editors can change it.');
        }
        return doc;
    };
    const peopleOf = (req, versions) => describePeople(
        versions.flatMap((v) => [v.createdBy, ...(v.contributors || []).map((c) => c.userId)]), orgIdOf(req));
    /** The live facade of a page, or a 503 when whether it is live cannot be told. */
    const liveOf = async (doc) => {
        try { return await liveCollabFor(doc); } catch {
            throw new HttpError(503, 'collab_unavailable', 'Live editing is not answering right now. Please try again in a moment.');
        }
    };
    const metaOf = async (req, versionId) => {
        const read = await documents().getVersion(req.params.id, userIdOf(req), versionId);
        if (!read) return null;
        const { content: _content, ...meta } = read.version;
        return meta;
    };

    router.get('/', requireAuth, validate({ query: S.list }), async (req, res) => {
        const page = await documents().listVersions(req.params.id, userIdOf(req), {
            cursor: req.query.cursor || null, limit: req.query.limit ? Number(req.query.limit) : 30,
        });
        if (!page) throw notFound('document_not_found', 'Document not found');
        res.json({ ...page, people: await peopleOf(req, page.versions) });
    });

    router.get('/:ref', requireAuth, async (req, res) => {
        const ref = checkRef(req);
        const read = await documents().getVersion(req.params.id, userIdOf(req), ref);
        if (!read) throw notFound('version_not_found', 'Version not found');
        let html = read.version.content.html;
        if (ref === 'current') {
            const live = await liveOf(read.document);
            if (live && typeof live.readHtml === 'function') html = await live.readHtml('document', read.document.id);
        }
        const version = { ...read.version, content: { html: sanitize(html || ''), markdown: null } };
        res.json({ version, people: await peopleOf(req, [version]) });
    });

    router.post('/', requireAuth, validate({ body: S.create }), async (req, res) => {
        const doc = await writable(req);
        const live = await liveOf(doc);
        let version;
        try {
            if (live && typeof live.readHtml === 'function') {
                const html = await live.readHtml('document', doc.id);
                const written = await documents().recordVersion(doc.id, {
                    html, source: 'named', name: req.body.name, createdBy: userIdOf(req),
                    contributors: [{ userId: userIdOf(req), kind: 'user' }],
                });
                version = written ? await metaOf(req, written.versionId) : null;
            } else {
                version = await documents().createNamedVersion(doc.id, await context(req), req.body.name);
            }
        } catch (err) { throw fromStore(err); }
        if (!version) throw notFound('document_not_found', 'Document not found');
        await feed().recordContentChange(doc, { actorId: userIdOf(req), source: 'named', versionId: version.id });
        res.status(201).json({ version });
    });

    router.put('/:ref/name', requireAuth, validate({ body: S.name }), async (req, res) => {
        const ref = checkRef(req);
        await writable(req);
        let version;
        try { version = await documents().nameVersion(req.params.id, await context(req), ref, req.body.name || null); }
        catch (err) { throw fromStore(err); }
        if (!version) throw notFound('version_not_found', 'Version not found');
        res.json({ version });
    });

    router.post('/:ref/restore', requireAuth, validate({ body: S.restore }), async (req, res) => {
        const ref = checkRef(req);
        if (ref === 'current') throw notFound('version_not_found', 'Version not found');
        const doc = await writable(req);
        const expected = req.body.expectedVersion || req.body.expectedVersionId || undefined;
        const live = await liveOf(doc);
        let out = null;
        try {
            if (live) out = await restoreLive(req, doc, ref, live, expected);
            if (!out) out = await documents().restoreVersion(doc.id, await context(req), ref, { expectedVersionId: expected });
        } catch (err) { throw fromStore(err); }
        if (!out) throw notFound('version_not_found', 'Version not found');
        // The live layer tells the change feed itself; told again, "since your
        // last visit" would count one restore twice.
        if (!out.live) await feed().recordContentChange(doc, { actorId: userIdOf(req), source: 'restore', versionId: out.version?.id || null });
        res.json({ version: out.version, current: out.current, document: out.current });
    });

    /**
     * A restore into a page edited live. The live layer is the ONE writer of
     * it: it keeps the live state as pre_restore, replaces the live document
     * (every open editor follows), records the rendered result as the
     * 'restore' version pointing at `ref`, and tells the change feed
     * (core/collab lifecycle applyServerEdit). Writing any of that here as
     * well left the restore without the version it came from, or recorded it
     * twice. Null when the live layer says there is no live document after
     * all, and the stored-body restore takes over.
     */
    async function restoreLive(req, doc, ref, live, expected) {
        if (expected && expected !== doc.versionId) {
            throw Object.assign(new Error('This page changed since you opened its history. Look at the newest version first.'), { status: 409, errorClass: 'document_conflict' });
        }
        const target = await documents().getVersion(doc.id, userIdOf(req), ref);
        if (!target) return null;
        const applied = await live.applyServerEdit('document', doc.id, { origin: 'restore', actorId: userIdOf(req), restoredFrom: ref },
            { replaceWith: { html: target.version.content.html } });
        if (!applied?.applied) return null;
        const current = await documents().getDocument(doc.id, userIdOf(req));
        // No version when the live page already said exactly this.
        const versionId = applied.versionId || current?.versionId || null;
        return { version: versionId ? await metaOf(req, versionId) : null, current, live: true };
    }

    router.delete('/:ref', requireAuth, async (req, res) => {
        const ref = checkRef(req);
        let out;
        try { out = await documents().deleteVersion(req.params.id, userIdOf(req), ref, { referencedIds: pinnedVersionIds }); }
        catch (err) { throw fromStore(err); }
        if (!out) throw notFound('version_not_found', 'Version not found');
        res.json({ success: true });
    });

    return router;
}

module.exports = makeDocumentVersionsRouter();
module.exports.makeDocumentVersionsRouter = makeDocumentVersionsRouter;
module.exports._schemas = { S, z };
