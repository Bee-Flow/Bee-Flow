// @typecheck
/**
 * The knowledge base that holds a project's files, as RETRIEVAL sees it.
 *
 * Every collaborative project gets one knowledge base of its own, created the
 * first time somebody uploads a file into it (projects/projectFiles.js). It is
 * owned by the project's owner and lives in the project's organisation, but it
 * is not a base anybody shared: it is the project's filing cabinet. Whoever is
 * a member of the project may search it, because being a member is what
 * "these are the project's files" means.
 *
 * ── WHY THE ORDINARY FILTER CANNOT ANSWER THIS ──────────────────────
 * `kbVisibility.filterKbIdsForUser` asks "may this person read this base?"
 * through `canUserAccessKB`, and for a `project_files` base that ACL answers
 * yes to its owner (and a super admin) only: never an org admin, never a
 * "published" flag, and the generic routes refuse to publish, rename, delete
 * or write into it (stores/knowledgeBases.js PROJECT_FILES_KIND,
 * routes/knowledgeBases/shared.js blockIfSystemKB). So for every member except
 * the owner the ordinary filter says no, and the agent path would quietly stop
 * quoting the files the member can see listed on the project page.
 *
 * So this module splits the project's list in two:
 *
 *   the files base   → kept for any member, but only after it is verified to
 *                      BE this project's files base (source kind, id recorded
 *                      on the project, same organisation). A project row that
 *                      named somebody else's base as its "files" would
 *                      otherwise be a way to read that base.
 *   everything else  → handed to the caller's own per-asker filter, unchanged.
 *
 * The caller MUST have established membership first (resolveRequestedProject
 * or requireProjectRole). This module does not look at roles: it is given a
 * project the asker belongs to and answers which of its bases may be searched.
 *
 * Pure apart from one `getKB`, which is injectable.
 */

const log = require('../../telemetry/log');

/** `knowledge_bases.source_kind` of a project's files base. */
const PROJECT_FILES_SOURCE_KIND = 'project_files';

/** The files-base id a project records, or null. */
function filesKbIdOf(project) {
    const id = project && project.filesKbId;
    return typeof id === 'string' && id ? id : null;
}

/**
 * Is `kb` the files base of `project`?
 *
 * Org-less on both sides counts as a match (`projects.organization_id` is ''
 * for a personal project, `knowledge_bases.organization_id` is NULL).
 *
 * @param {object|null} kb       a knowledge_bases row
 * @param {object|null} project  a projectStore.getProject() result
 */
function isProjectFilesKb(kb, project) {
    const filesKbId = filesKbIdOf(project);
    if (!kb || !filesKbId) return false;
    if (kb.source_kind !== PROJECT_FILES_SOURCE_KIND) return false;
    if (String(kb.id) !== filesKbId) return false;
    return (kb.organization_id || '') === (project.organizationId || '');
}

/**
 * The bases a MEMBER may search in one of the project's chats.
 *
 * @param {object} project  getProject() shape: knowledgeBaseIds, filesKbId, organizationId
 * @param {object} p
 * @param {(ids: string[]) => Promise<string[]>} p.filterAttached
 *        the asker's own filter for the attached bases (visibleKbIdsFor,
 *        filterKbIdsForUser, ...). Called with the files base taken out.
 * @param {boolean} [p.includeFiles=true]
 *        false where the asker is not a real member, e.g. a "Test as · group"
 *        preview: a simulated group member is nobody's colleague.
 * @param {{ kbStore?: { getKB: (id: string) => Promise<any> } }} [p.deps]
 * @returns {Promise<string[]>} the files base first (when kept), then the
 *          attached bases that survived the asker's filter, in stored order
 */
async function searchableProjectKbIds(project, { filterAttached, includeFiles = true, deps = {} } = /** @type {any} */ ({})) {
    if (!project) return [];
    const filesKbId = filesKbIdOf(project);
    const stored = Array.isArray(project.knowledgeBaseIds) ? project.knowledgeBaseIds : [];
    const attached = stored.filter(id => typeof id === 'string' && id && id !== filesKbId);

    const kept = attached.length > 0 && typeof filterAttached === 'function'
        ? await filterAttached(attached)
        : [];
    if (!filesKbId || !includeFiles) return kept;

    const store = deps.kbStore || require('../../stores/knowledgeBases');
    let kb = null;
    try { kb = await store.getKB(filesKbId); } catch (e) {
        // Unreadable is not "allowed": the turn goes on without the files.
        log.warn('[ProjectFilesKb] files base lookup failed:', e.message);
        kb = null;
    }
    if (!isProjectFilesKb(kb, project)) {
        if (kb) {
            log.warn('[ProjectFilesKb] project names a base that is not its files base', JSON.stringify({
                projectId: project.id || null, kbId: filesKbId,
            }));
        }
        return kept;
    }
    return [filesKbId, ...kept.filter(id => id !== filesKbId)];
}

module.exports = {
    PROJECT_FILES_SOURCE_KIND,
    filesKbIdOf,
    isProjectFilesKb,
    searchableProjectKbIds,
};
