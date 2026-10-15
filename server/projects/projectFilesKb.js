'use strict';

/**
 * The project's files knowledge base (projectFiles.js): find it, create it on
 * first use, keep it listed on the project, and delete it with the project.
 * Built from the collaborators makeProjectFiles resolves from its deps, and
 * from `ctx.kit` (HttpError, notFound and the core/kb/projectFilesKb helpers),
 * which are passed in so this file does not join the import cycle that
 * file's lazy requires put projectFiles.js in.
 */


/** Where the project's chats may use the base. Not an access rule (see core/kb/usageContexts.js). */
const USAGE_CONTEXTS = Object.freeze(['agent', 'direct_chat']);

/** The base's name: "<project> · Files", within the KB name column's reasonable length. */
function filesKbName(project) {
    const base = String(project?.name || 'Project').replace(/\s+/g, ' ').trim() || 'Project';
    return `${base.slice(0, 180)} · Files`;
}

function storedIds(project) {
    const ids = Array.isArray(project?.knowledgeBaseIds) ? project.knowledgeBaseIds : [];
    return ids.filter(id => typeof id === 'string' && id);
}

/**
 * @param {object} ctx
 * @param {() => object} ctx.kbStore
 * @param {() => object} ctx.projectStore
 * @param {() => object} ctx.helpers
 * @param {() => number} ctx.maxKbIds
 * @param {Function} ctx.publishTransient
 * @param {object} ctx.log
 * @param {() => Function} ctx.resolveKbProvider
 * @param {() => Function} ctx.deleteChunksLocally
 * @param {object} ctx.kit
 */
function makeFilesKbAccess(ctx) {
    const { kbStore, projectStore, helpers, maxKbIds, publishTransient, log } = ctx;
    const { HttpError, notFound, PROJECT_FILES_SOURCE_KIND, filesKbIdOf, isProjectFilesKb } = ctx.kit;

    /**
     * The project's files base, or null when it has none (yet). A recorded id
     * that resolves to something that is not this project's files base is
     * treated as none: it is never read as the project's files.
     */
    async function getFilesKb(project) {
        const id = filesKbIdOf(project);
        if (!id) return null;
        const kb = await kbStore().getKB(id);
        return isProjectFilesKb(kb, project) ? kb : null;
    }

    /**
     * Make sure the files base is in `knowledge_base_ids`, which is what the
     * direct-chat path searches. Compare-and-swap on the project's version
     * like every other writer of that column (knowledgeBaseMembership.js), so
     * a colleague's KB change a moment earlier is kept, not overwritten.
     *
     * Best-effort: the agent path and the team-chat assistant reach the files
     * through `files_kb_id` either way, so a failure here is logged, not
     * raised. Returns true when this call added the id.
     */
    async function ensureListed(projectId, kbId) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const project = await projectStore().getProject(projectId);
            if (!project) return false;
            const ids = storedIds(project);
            if (ids.includes(kbId)) return false;
            if (ids.length >= maxKbIds()) {
                log.warn(`[ProjectFiles] project ${projectId} already holds ${ids.length} knowledge bases; its files base is searched through files_kb_id only`);
                return false;
            }
            if (!Number.isFinite(Number(project.version))) return false;
            const result = await projectStore().updateProject(
                projectId, { knowledgeBaseIds: [...ids, kbId] }, { expectedVersion: Number(project.version) },
            );
            if (!result) return false;
            if (result.conflict) continue;
            // The project row's version moved: open settings forms must reload
            // before they save, or their next PUT is a needless conflict.
            try {
                await publishTransient(projectId, { kind: 'project_updated', payload: { changes: ['knowledgeBaseIds'] } });
            } catch (_) { /* presence-grade: never fail the upload over it */ }
            return true;
        }
        log.warn(`[ProjectFiles] could not list the files base on project ${projectId} after three attempts`);
        return false;
    }

    async function discardBase(kb) {
        try { await kbStore().deleteKB(kb.id); } catch (e) {
            log.warn(`[ProjectFiles] could not remove the redundant files base ${kb.id}:`, e.message);
        }
    }

    /**
     * The project's files base, created on first use.
     * @param {object} project  a getProject() result
     */
    async function ensureFilesKb(project) {
        const recorded = filesKbIdOf(project);
        if (recorded) {
            const existing = await kbStore().getKB(recorded);
            if (isProjectFilesKb(existing, project)) {
                await ensureListed(project.id, existing.id);
                return existing;
            }
            if (existing) {
                // The project names a base that is not its files base. Refuse
                // rather than upload into somebody else's knowledge base.
                log.error(`[ProjectFiles] project ${project.id} records base ${recorded} as its files, but it is not`);
                throw new HttpError(409, 'FILES_UNAVAILABLE', 'The files of this project cannot be stored right now.');
            }
            // Recorded, but the base is gone: make a new one below and replace
            // the stale id (only if it is still the one we saw).
        }

        const kb = await kbStore().createKB(
            project.ownerId,
            filesKbName(project),
            'Files uploaded into this project. Every member of the project can search them in its chats.',
            project.organizationId || null,
            { sourceKind: PROJECT_FILES_SOURCE_KIND, usageContexts: [...USAGE_CONTEXTS] },
        );

        let winner;
        try {
            winner = recorded
                ? await projectStore().setFilesKbId(project.id, kb.id, { expected: recorded })
                : await projectStore().setFilesKbId(project.id, kb.id);
        } catch (e) {
            await discardBase(kb);
            throw e;
        }
        if (winner === kb.id) {
            log.info(`[ProjectFiles] created files base ${kb.id} for project ${project.id}`);
            await ensureListed(project.id, kb.id);
            return kb;
        }

        // Somebody else's first upload won (or the project went away).
        await discardBase(kb);
        if (!winner) throw notFound('not_found', 'Not found');
        const other = await kbStore().getKB(winner);
        if (!isProjectFilesKb(other, { ...project, filesKbId: winner })) {
            throw new HttpError(409, 'FILES_UNAVAILABLE', 'The files of this project cannot be stored right now.');
        }
        await ensureListed(project.id, other.id);
        return other;
    }

    /**
     * Delete the project's files base with every chunk in it. For the project
     * delete path: a base nobody can reach any more is personal data kept for
     * no purpose. Mirrors routes/knowledgeBases/detail.js DELETE.
     * @returns {Promise<boolean>} true when a base was removed
     */
    async function removeFilesKb(project) {
        const kb = await getFilesKb(project);
        if (!kb) return false;
        const store = kbStore();
        const resolveKbProvider = ctx.resolveKbProvider();
        const deleteChunksLocally = ctx.deleteChunksLocally();

        if ((await resolveKbProvider()) !== 'local') {
            const PAGE = 200;
            for (let offset = 0; offset < PAGE * 50; offset += PAGE) {
                const docs = await store.listDocuments(kb.id, { limit: PAGE, offset });
                if (!docs || docs.length === 0) break;
                for (const doc of docs) await helpers().purgeDocumentChunks(kb.id, doc.id, kb.tenant_id);
                if (docs.length < PAGE) break;
            }
        }
        try { await deleteChunksLocally(kb.tenant_id, kb.id); } catch (e) {
            log.warn(`[ProjectFiles] local chunk cleanup for ${kb.id} failed:`, e.message);
        }
        await store.deleteKB(kb.id);
        return true;
    }

    return { getFilesKb, ensureFilesKb, removeFilesKb };
}

module.exports = { makeFilesKbAccess, filesKbName, storedIds };
