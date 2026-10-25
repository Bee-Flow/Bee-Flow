// @typecheck strict
/**
 * Finding a co-edited document for the service (./service.js): the project
 * behind an authorised request, the document found only through that project
 * (briefly cached for the write path), and the one-time seed of a new
 * document from its resource's legacy content.
 */

'use strict';

const Y = require('yjs');
const { HttpError, notFound } = require('../http/errors');
const { inspectUpdate } = require('./wire');
const { DISABLED_TEXT, UNSUPPORTED_TEXT } = require('./serviceErrors');

const DOC_CACHE_MS = 10_000;

/** @param {any} ctx the shared context built in index.js */
function makeDocAccess(ctx) {
    const { store, converter, resources } = ctx;

    /** docId → { at, doc, project } for the hot write path. */
    const docCache = new Map();

    /**
     * The project behind an authorised request, and whether co-editing may
     * run in it at all.
     * @param {string} projectId
     */
    async function usableProject(projectId) {
        const project = await ctx.projectInfo(projectId);
        if (!project) throw notFound('not_found', 'Not found');
        if (project.kind === 'solution') throw new HttpError(409, 'COLLAB_UNSUPPORTED', UNSUPPORTED_TEXT);
        if (!(await ctx.settings.isCollabEnabled(project.organizationId))) throw new HttpError(503, 'COLLAB_DISABLED', DISABLED_TEXT);
        return project;
    }

    /**
     * The document, found through the project that authorised the request,
     * with its resource still filed there. Cached briefly for the write path;
     * `fresh` skips the cache.
     * @param {string} projectId @param {string} docId @param {{ fresh?: boolean }} [opts]
     */
    async function resolveDoc(projectId, docId, { fresh = false } = {}) {
        const hit = docCache.get(docId);
        if (!fresh && hit && Date.now() - hit.at < DOC_CACHE_MS && hit.doc.projectId === projectId) {
            if (!(await ctx.settings.isCollabEnabled(hit.project.organizationId))) throw new HttpError(503, 'COLLAB_DISABLED', DISABLED_TEXT);
            return hit;
        }
        const project = await usableProject(projectId);
        const doc = await store.findDoc(projectId, docId);
        if (!doc || !doc.seededAt) throw notFound('not_found', 'Not found');
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        if (!resource || resource.projectId !== projectId || !resource.supported) {
            docCache.delete(docId);
            throw notFound('not_found', 'Not found');
        }
        const entry = { at: Date.now(), doc, project };
        docCache.set(docId, entry);
        if (docCache.size > 5000) docCache.delete(docCache.keys().next().value);
        return entry;
    }

    /**
     * Seed a brand-new document from the resource's legacy content, once,
     * under the document row lock (stores/collabDocStore.seedOnce).
     * @param {any} doc @param {any} project
     */
    async function seed(doc, project) {
        const c = await ctx.cryptoFor(doc, project);
        return store.seedOnce(doc.id, async () => {
            // Read inside the lock, with the resource row's own share lock: the
            // freshest legacy content is what counts, a save in flight included.
            const resource = await resources.load(doc.resourceKind, doc.resourceId, { lock: true });
            if (!resource) return null;
            const ast = converter.legacyToAst({ html: resource.html, markdown: resource.markdown });
            if (converter.isEmpty(ast)) return null;
            const ydoc = new Y.Doc();
            try {
                converter.replaceWith(ydoc, ast, 'import');
                const update = Y.encodeStateAsUpdate(ydoc);
                const { clients } = inspectUpdate(update);
                return {
                    byteLen: update.length,
                    clients: [...clients].map(([clientId, to]) => ({ clientId, to })),
                    seal: (/** @type {number} */ seq) => c.sealUpdate(seq, update),
                    sealCheckpoint: (/** @type {number} */ seq) => c.sealCheckpoint(seq, update),
                    // What the owner holds is what the mirror starts from.
                    contentBytes: Buffer.byteLength(resource.html || '', 'utf8'),
                };
            } finally {
                ydoc.destroy();
            }
        });
    }

    /** Forget cached document lookups (after a detach). @param {string} [docId] */
    function forget(docId) {
        if (docId) docCache.delete(docId); else docCache.clear();
    }

    return { usableProject, resolveDoc, seed, forget };
}

module.exports = { makeDocAccess };
