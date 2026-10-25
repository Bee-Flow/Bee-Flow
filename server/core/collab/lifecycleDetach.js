// @typecheck strict
/**
 * Detaching co-edited documents (./lifecycle.js): fold the final state into
 * the resource, keep a version, and delete the co-editing state — for one
 * resource, a whole project, or an organisation that switched co-editing off.
 *
 * `orgIds` resolves an organisation id the way the connection store does
 * (stores/integrationConnectionStore.resolveOrgId, handed in lazily by
 * ./lifecycle): that store sits in the server's large import cycle, which
 * this module stays out of.
 */

'use strict';

// A fold-back that finds the log moved on (a fence that expired) goes again.
const FOLD_BACK_ATTEMPTS = 3;
// One page of an organisation's documents when co-editing is switched off.
const ORG_BATCH = 500;

/**
 * @param {any} ctx the shared context built in index.js
 * @param {ReturnType<typeof import('./lifecycleBase').makeLifecycleBase>} base
 * @param {ReturnType<typeof import('./lifecycleVersions').makeLifecycleVersions>} versions
 * @param {() => { resolveOrgId: (orgId: string|null) => any }} orgIds
 */
function makeLifecycleDetach(ctx, base, versions, orgIds) {
    const { store, resources, log } = ctx;
    const { soft, open } = base;
    const { materialise, closeSession } = versions;

    /**
     * Is the document still attached to a resource filed in its project, with
     * co-editing on? Answers the resource when it is.
     * @param {any} doc
     */
    async function stillValid(doc) {
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        // An archived page: gone for its editors, but still a row to fold back into.
        if (!resource || resource.projectId !== doc.projectId || !resource.supported) {
            return { ok: false, resource, reason: !resource || resource.archived ? 'deleted' : 'detached' };
        }
        const project = await ctx.projectInfo(doc.projectId);
        if (!project || project.kind === 'solution') return { ok: false, resource, reason: 'detached' };
        if (!(await ctx.settings.isCollabEnabled(project.organizationId))) return { ok: false, resource, reason: 'disabled' };
        return { ok: true, resource, reason: null };
    }

    /**
     * Fold one document into its resource and delete the co-editing state.
     * The resource row gets the final state (unless the resource itself is
     * gone), a version is kept when anything changed since the last one, and
     * every open stream is told `doc.closed`.
     *
     * Nothing that was not written back is ever deleted. Appends are fenced
     * off first (an update acknowledged after the final read would otherwise
     * go with the document), and the delete only succeeds for the state that
     * was written. Throws, keeping the state, when it cannot be read (a
     * missing key) or the owner refuses it (a page over its size cap).
     *
     * @param {any} doc @param {string} reason
     */
    async function detachDoc(doc, reason) {
        const resource = await resources.load(doc.resourceKind, doc.resourceId);
        if (doc.seededAt && resource) {
            if (await store.fence(doc.id)) {
                try {
                    await foldBack(doc, resource);
                } catch (err) {
                    await soft('opening the document to edits again', () => store.unfence(doc.id));
                    throw err;
                }
            }
        } else {
            // Nothing to write back into a resource that is gone: its sealed
            // state is deleted unopened, so a missing key never keeps a
            // deleted item's editing state around.
            await store.deleteDoc(doc.id);
        }
        ctx.service().forget(doc.id);
        ctx.hub.close(doc.id, reason);
        await soft('the closing notice', () => ctx.publishTransient(doc.projectId, { kind: 'doc.closed', docId: doc.id, reason }));
        log.info(`[Collab] document ${doc.id} detached (${reason})`);
    }

    /**
     * The fenced part of a detach: the final state into the resource, a
     * version, then the delete — compare-and-set on the seq that was written,
     * so a fence that expired mid-way costs another round, never an update.
     *
     * The state is written back when the resource is still filed where the
     * state came from (or unfiled), and ALSO when it is filed elsewhere now
     * but the mirror is behind: those edits exist nowhere else, and there is
     * one document per resource, so nobody co-edited the resource since. A
     * resource filed elsewhere whose mirror is current is left alone.
     *
     * @param {any} doc @param {{ projectId: string|null }} resource
     */
    async function foldBack(doc, resource) {
        for (let attempt = 0; attempt < FOLD_BACK_ATTEMPTS; attempt += 1) {
            const s = await open(doc, { withCheckpoint: true });
            if (!s) return;
            try {
                const fresh = s.doc;
                const ownRow = resource.projectId === fresh.projectId || resource.projectId === null;
                const unwritten = fresh.materializedSeq < s.seq;
                if (unwritten) {
                    const out = await materialise(fresh, s, s.seq);
                    if (out.gone) return;
                    if (out.refused || out.busy) {
                        throw Object.assign(new Error(`the ${doc.resourceKind} did not take the final state (${out.refused ? out.reason || 'refused' : 'busy'}); it is kept`),
                            { code: 'NOT_FOLDED_BACK' });
                    }
                }
                if ((ownRow || unwritten) && fresh.checkpointSeq < s.seq && (await closeSession(fresh, s, { source: 'checkpoint' })).busy) {
                    throw Object.assign(new Error('the version of the final state could not be written (busy); it is kept'), { code: 'NOT_FOLDED_BACK' });
                }
            } finally {
                s.ydoc.destroy();
            }
            if (await store.deleteDoc(doc.id, { uptoSeq: s.seq })) return;
        }
        throw Object.assign(new Error('the document kept changing while it was folded back; it is kept'), { code: 'NOT_FOLDED_BACK' });
    }

    /**
     * `detach(kind, resourceId)` for the resource owners: the item left its
     * project, was deleted, or co-editing was switched off.
     * @param {string} kind @param {string} resourceId @param {{ reason?: string }} [opts]
     */
    async function detach(kind, resourceId, { reason = 'detached' } = {}) {
        const docs = await store.listByResource(kind, resourceId);
        for (const doc of docs) await detachDoc(doc, reason);
        return { detached: docs.length };
    }

    /**
     * Detach each of `docs`; one that cannot be folded back is logged (by
     * `warning`) and kept, and the rest go on past it.
     * @param {any[]} docs @param {string} reason @param {(doc: any, err: Error) => string} warning
     */
    async function detachEach(docs, reason, warning) {
        let detached = 0;
        let failed = 0;
        for (const doc of docs) {
            try {
                await detachDoc(doc, reason);
                detached += 1;
            } catch (err) {
                failed += 1;
                log.warn(warning(doc, /** @type {Error} */ (err)));
            }
        }
        return { detached, failed };
    }

    /**
     * Fold back every document of a project that is about to be deleted,
     * while its items are still filed in it (so each is written back into
     * its own row). One that cannot be read is logged; the project's delete
     * then removes its state with it.
     * @param {string} projectId
     */
    async function detachProject(projectId) {
        const docs = await store.listByProject(projectId);
        return detachEach(docs, 'deleted',
            (doc, err) => `[Collab] could not fold back ${doc.id} before its project was deleted: ${err.message}`);
    }

    /**
     * Fold back every document of an organisation (co-editing was switched
     * off), page by page until none is left: the org root key rotation
     * refuses while any remains (auth/projectEscrow.js). One document that
     * cannot be folded back is logged and kept, and the pages go on past it.
     * @param {string|null} orgId @param {{ batch?: number }} [opts]
     */
    async function detachOrganisation(orgId, { batch = ORG_BATCH } = {}) {
        const { resolveOrgId } = orgIds();
        const org = resolveOrgId(orgId);
        const fallback = resolveOrgId(null);
        let detached = 0;
        let failed = 0;
        let afterId = '';
        for (;;) {
            const docs = await store.listByOrg(org, fallback, { afterId, limit: batch });
            if (!docs.length) break;
            const page = await detachEach(docs, 'disabled', (doc, err) => `[Collab] could not fold back ${doc.id}: ${err.message}`);
            detached += page.detached;
            failed += page.failed;
            afterId = docs[docs.length - 1].id;
        }
        return { detached, failed };
    }

    return { stillValid, detachDoc, detach, detachProject, detachOrganisation };
}

module.exports = { makeLifecycleDetach };
