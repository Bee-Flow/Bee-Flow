// @typecheck
/**
 * Real-time co-editing — the one module every other part of the server talks
 * to about co-edited content.
 *
 * ── For resource owners (notebooks, project pages, comments, versions) ──────
 *
 *   isActive(kind, resourceId)            is this resource co-edited right now?
 *   readMarkdown(kind, resourceId)         current content, freshly rendered from
 *   readHtml(kind, resourceId)             the live state (null: not co-edited,
 *   read(kind, resourceId)                 read your own column); `read` gives
 *                                          {html, markdown, text, wordCount, seq}
 *                                          in one go, and each brings a lagging
 *                                          mirror up to date on the way
 *   applyServerEdit(kind, resourceId,      an AI / restore / system write as an
 *     {origin, actorId, agentId?, …},      ordinary update; `{applied:false}`
 *     {replaceWith|append: {markdown|html|ast}})  when not co-edited (use your
 *                                          own single-writer path)
 *   detach(kind, resourceId)               the resource left its project (or is
 *                                          deleted): final state into its row,
 *                                          a version, co-editing state deleted
 *   detachProject(projectId)               the same for every document of a
 *                                          project that is about to be deleted
 *
 * `kind` is 'notebook' or 'document' (a project page).
 *
 * ── For the routes (routes/projects/collab.js, the project stream) ──────────
 *
 *   openDoc, sync, applyClientUpdates, awareness, attachStream
 *
 * ── How it fits together ────────────────────────────────────────────────────
 *
 *   stores/collabDocStore.js   the update log (Postgres is the authority), with
 *                              the mirror lease, fold-back fence and job
 *                              back-off of stores/collabDocLeases.js
 *   limits.js                  caps and timings (the route schemas derive theirs)
 *   frame.js                   sealing with a key derived from the project key
 *   wire.js                    validation of everything a client sends
 *   docHub.js                  per-replica fan-out onto open project streams
 *   convert.js                 Yjs ⇄ editor AST ⇄ HTML/Markdown (editor bundle)
 *   resources.js               where a resource is filed, and its owners' hooks
 *   service.js / lifecycle.js  the operations
 *   jobs/collabDocCompaction.js  materialise, checkpoint, compact on a timer
 *
 * `makeCollab(deps)` builds an instance over injected collaborators (tests
 * serve the routes with fakes and PGlite); the default export wires the real
 * ones lazily, so requiring this module loads no store and opens no pool.
 */

'use strict';

const { makeService } = require('./service');
const { makeLifecycle } = require('./lifecycle');
const { makeDocHub } = require('./docHub');
const { makeCollabCrypto } = require('./frame');
const { makeConverter } = require('./convert');
const { makeResources } = require('./resources');
const { defaultLimits } = require('./limits');

const PROJECT_CACHE_MS = 30_000;

/**
 * @param {{
 *   store?: any, hub?: any, converter?: any, resources?: any, settings?: any,
 *   getProjectKey?: (projectId: string, orgId: string|null) => Promise<Buffer>,
 *   getProject?: (id: string) => Promise<any>,
 *   publishTransient?: (projectId: string, ev: object) => Promise<any>,
 *   emitProjectEvent?: (projectId: string, ev: object) => Promise<any>,
 *   changeFeed?: () => any, contentSignals?: () => any,
 *   subscribeProject?: Function, isDistributed?: () => boolean,
 *   limits?: object, log?: any,
 * }} [deps]
 */
function makeCollab(deps = {}) {
    const log = deps.log || require('../../telemetry/log');
    const store = deps.store || require('../../stores/collabDocStore');
    const collabCrypto = makeCollabCrypto({ getProjectKey: deps.getProjectKey });
    const projectCache = new Map();

    /** @param {string} projectId */
    async function projectInfo(projectId) {
        const hit = projectCache.get(projectId);
        if (hit && Date.now() - hit.at < PROJECT_CACHE_MS) return hit.project;
        const getProject = deps.getProject || require('../../stores/projectStore').getProject;
        const p = await getProject(projectId);
        const project = p ? { id: p.id, kind: p.kind ?? null, organizationId: p.organizationId ?? null } : null;
        projectCache.set(projectId, { at: Date.now(), project });
        if (projectCache.size > 2000) projectCache.delete(projectCache.keys().next().value);
        return project;
    }

    /** @type {any} */
    const ctx = {
        log,
        store,
        limits: { ...defaultLimits(), ...(deps.limits || {}) },
        converter: deps.converter || makeConverter(),
        resources: deps.resources || makeResources(),
        settings: deps.settings || require('./settings'),
        projectInfo,
        /** @param {any} doc @param {any} [project] */
        async cryptoFor(doc, project) {
            const p = project || await projectInfo(doc.projectId);
            if (!p) throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
            return collabCrypto.forDoc({ id: doc.id, projectId: doc.projectId, orgId: p.organizationId, keyScope: doc.keyScope });
        },
        publishTransient: deps.publishTransient
            || ((/** @type {string} */ projectId, /** @type {object} */ ev) => require('../projectEventBus').publishTransient(projectId, ev)),
        emitProjectEvent: deps.emitProjectEvent
            || ((/** @type {string} */ projectId, /** @type {object} */ ev) => require('../projectFeed').emitProjectEvent(projectId, ev, { label: 'Collab' })),
        changeFeed: deps.changeFeed || (() => optional('../../projects/changeFeed')),
        contentSignals: deps.contentSignals || (() => optional('../dlp/contentSignals')),
        /**
         * The resource owner's cap on the rendered body (a page's), or null.
         * @param {string} kind @returns {number|null}
         */
        maxContentBytes(kind) {
            const r = ctx.resources;
            const cap = typeof r.maxContentBytes === 'function' ? Number(r.maxContentBytes(kind)) : NaN;
            return Number.isFinite(cap) && cap > 0 ? cap : null;
        },
    };

    ctx.hub = deps.hub || makeDocHub({
        listUpdates: (docId, afterSeq, limit) => store.listUpdates(docId, afterSeq, limit),
        readHead: (docId) => store.getDoc(docId),
        async openRows(doc, rows) {
            const c = await ctx.cryptoFor(doc);
            return rows.map((r) => c.openUpdate(r.seq, /** @type {Buffer} */ (r.body)));
        },
        subscribeProject: /** @type {any} */ (deps.subscribeProject),
        isDistributed: deps.isDistributed,
        log,
    });

    /**
     * A stored update: to this replica's streams directly (with its
     * plaintext), then the doorbell for the other replicas (ids only).
     * @param {{ id: string, projectId: string }} doc @param {{ seq: number, u: Uint8Array, by: string }} update
     */
    ctx.announce = (doc, update) => {
        ctx.hub.localAppend(doc.id, update);
        Promise.resolve(ctx.publishTransient(doc.projectId, { kind: 'doc.moved', docId: doc.id, seq: update.seq }))
            .catch((err) => log.warn(`[Collab] doorbell failed: ${err.message}`));
    };

    const lifecycle = makeLifecycle(ctx);
    ctx.lifecycle = lifecycle;
    const service = makeService(ctx);
    ctx.service = () => service;

    return {
        // Resource owners
        isActive: lifecycle.isActive,
        readMarkdown: lifecycle.readMarkdown,
        readHtml: lifecycle.readHtml,
        read: lifecycle.read,
        applyServerEdit: lifecycle.applyServerEdit,
        detach: lifecycle.detach,
        detachProject: lifecycle.detachProject,
        detachOrganisation: lifecycle.detachOrganisation,
        // Routes and streams
        openDoc: service.openDoc,
        sync: service.sync,
        applyClientUpdates: service.applyClientUpdates,
        awareness: service.awareness,
        attachStream: service.attachStream,
        kindOf: service.kindOf,
        // The job
        processDoc: lifecycle.processDoc,
        // The store takes the thresholds by the names limits.js gives them.
        listWork: () => store.listWork({ ...ctx.limits, limit: 50 }),
        limits: ctx.limits,
        hub: ctx.hub,
        _ctx: ctx,
    };
}

/** A collaborator from another workstream that may not exist yet. @param {string} path */
function optional(path) {
    try {
        return require(path);
    } catch (err) {
        if (/** @type {any} */ (err).code === 'MODULE_NOT_FOUND') return null;
        throw err;
    }
}

/** @type {ReturnType<typeof makeCollab>|null} */
let _default = null;
function instance() {
    if (!_default) _default = makeCollab();
    return _default;
}

module.exports = {
    makeCollab,
    defaultLimits,
    instance,
    /** @param {string} kind @param {string} resourceId */
    isActive: (kind, resourceId) => instance().isActive(kind, resourceId),
    /** @param {string} kind @param {string} resourceId */
    readMarkdown: (kind, resourceId) => instance().readMarkdown(kind, resourceId),
    /** @param {string} kind @param {string} resourceId */
    readHtml: (kind, resourceId) => instance().readHtml(kind, resourceId),
    /** Both renderings (and the plain text) in one read. @param {string} kind @param {string} resourceId */
    read: (kind, resourceId) => instance().read(kind, resourceId),
    /** @param {string} kind @param {string} resourceId @param {any} actor @param {any} edit */
    applyServerEdit: (kind, resourceId, actor, edit) => instance().applyServerEdit(kind, resourceId, actor, edit),
    /** @param {string} kind @param {string} resourceId @param {{ reason?: string }} [opts] */
    detach: (kind, resourceId, opts) => instance().detach(kind, resourceId, opts),
    /** Fold back every co-edited document of a project that is about to be deleted. @param {string} projectId */
    detachProject: (projectId) => instance().detachProject(projectId),
    /** @param {string|null} orgId */
    detachOrganisation: (orgId) => instance().detachOrganisation(orgId),
};
