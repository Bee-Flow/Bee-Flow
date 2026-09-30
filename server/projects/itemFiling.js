// @typecheck
/**
 * Filing an item into a project, or taking it out (PUT /api/projects/:id/resources),
 * with what has to happen around the membership registry's `setProject`:
 *
 *   before   a notebook or project page that is co-edited where it is filed
 *            now has its live state folded back into its own row while it
 *            still belongs there (core/projectContent/itemLifecycle
 *            beforeMove), for a caller the stores will let move it
 *   move     `entry.setProject(...)`: the stores decide who may move what
 *   after    ONE feed entry per project the item entered or left:
 *            `content.moved_in` / `content.moved_out` for the kinds the change
 *            feed follows (notebooks, documents, meetings), `resource_added` /
 *            `resource_removed` for the rest; and the project-bound state of
 *            an item that left a project goes with it (its comment threads
 *            there, its compliance signal)
 *
 * Filing an item into the project it is already in changes nothing and
 * records nothing. Feed entries hold ids only.
 */

'use strict';

/** The kinds the change feed follows (projects/changeFeed ITEM_TYPES). */
const FEED_KINDS = Object.freeze(['notebook', 'document', 'meeting']);

/**
 * @param {{
 *   feed: { recordProjectChange: Function, recordItemMoved: Function },
 *   lifecycle?: { beforeMove: Function, leftProject: Function },
 * }} deps
 */
function makeItemFiling(deps) {
    const lifecycle = () => deps.lifecycle || require('../core/projectContent/itemLifecycle');

    /**
     * @param {{ entry: { setProject: Function }, kind: string, id: string, userId: string,
     *   projectId: string, attach: boolean, req?: any }} move
     * @returns {Promise<boolean>}  false when the stores refused (not found, or not yours to move)
     */
    async function fileItem({ entry, kind, id, userId, projectId, attach, req }) {
        const target = attach ? projectId : null;
        const where = await lifecycle().beforeMove({
            kind, id, userId, targetProjectId: target, fromProjectId: projectId, projectRole: req && req.projectRole,
        });
        // The fourth argument is the context a kind may need to answer the
        // move: the project being edited (which `target` cannot carry when the
        // caller is taking something OUT) and the request an access check is
        // made against. Kinds whose link is a column on their own row ignore it.
        const ok = await entry.setProject(id, userId, target, { req, projectId });
        if (!ok) return false;

        const previous = where ? where.projectId : undefined;
        if (attach && previous === projectId) return true;   // already here: nothing moved

        if (!FEED_KINDS.includes(kind)) {
            await deps.feed.recordProjectChange(projectId, userId, attach ? 'resource_added' : 'resource_removed', {
                targetType: kind, targetId: id,
            });
            return true;
        }
        const moved = (/** @type {string} */ pid, /** @type {'in'|'out'} */ direction) => deps.feed.recordItemMoved({
            projectId: pid, itemType: kind, itemId: id, actorId: userId, direction,
        });
        if (attach) {
            await moved(projectId, 'in');
            // Moved straight from another project: that one lost it.
            if (previous) {
                await moved(previous, 'out');
                await lifecycle().leftProject(kind, id, previous);
            }
        } else {
            await moved(projectId, 'out');
            await lifecycle().leftProject(kind, id, projectId);
        }
        return true;
    }

    return { fileItem };
}

module.exports = { makeItemFiling, FEED_KINDS };
