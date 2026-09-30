/**
 * Which of a notebook's knowledge bases may THIS caller have searched?
 *
 * A notebook's own base (the one its sources are ingested into, created as
 * the notebook owner's `notebook_auto` base) is part of the notebook: anyone
 * the notebook is shared with through a project reads it by that role, the
 * same way they read the sources list. The generic KB ACL said no to every
 * member (the base is the owner's private draft), so a project member's chat
 * and generation silently ran without a single source.
 *
 * Every OTHER base on the notebook is still authorised with the caller's own
 * KB access (support/kbAccess): attaching a base to a notebook must never
 * widen who can read it.
 *
 * The caller must already hold a role on the notebook (it was loaded through
 * notebookStore.getNotebook with their id).
 */

'use strict';

/**
 * @param {object} req
 * @param {{ userId: string, knowledgeBaseIds?: string[] }} notebook
 * @param {{ kbStore?: { getKB: (id: string) => Promise<any> }, partition?: (req: object, ids: string[]) => Promise<{allowed: string[], denied: string[]}> }} [deps]
 * @returns {Promise<{ allowed: string[], denied: string[] }>} ids in the notebook's order
 */
async function partitionNotebookKbIds(req, notebook, deps = {}) {
    const kbStore = deps.kbStore || require('../../stores/knowledgeBases');
    const partition = deps.partition || require('../../support/kbAccess').partitionAccessibleKBIds;
    const ids = (Array.isArray(notebook?.knowledgeBaseIds) ? notebook.knowledgeBaseIds : [])
        .filter((id) => typeof id === 'string' && id);
    const own = new Set();
    const rest = [];
    for (const id of ids) {
        let kb = null;
        try { kb = await kbStore.getKB(id); } catch { kb = null; }
        if (kb && kb.source_kind === 'notebook_auto' && kb.tenant_id === notebook.userId) own.add(id);
        else rest.push(id);
    }
    const checked = rest.length ? await partition(req, rest) : { allowed: [], denied: [] };
    const allowedRest = new Set(checked.allowed);
    return {
        allowed: ids.filter((id) => own.has(id) || allowedRest.has(id)),
        denied: checked.denied,
    };
}

module.exports = { partitionNotebookKbIds };
