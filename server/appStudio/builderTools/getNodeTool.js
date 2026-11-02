// @typecheck strict
/**
 * App Studio builder tool — app_get_node (read-only, full content of components).
 *
 * app_get_draft is a compact tree: long texts are cut with "…" and props such
 * as bindings, filters and computed are left out, because its job is ids and
 * structure. A caller that must EDIT an existing text or filter needs the whole
 * node first; this is that read.
 */

'use strict';

const ops = require('../definitionOps');

const MAX_GET_NODES = 40;

/**
 * @param {import('../builderTools').BuilderDraft} draftWrap
 * @param {import('../builderTools').ToolArgs} [args]
 * @returns {import('../builderTools').ToolResult}
 */
function applyGetNode(draftWrap, args = {}) {
    const raw = Array.isArray(args?.ids) ? args.ids : (typeof args?.ids === 'string' ? [args.ids] : []);
    const ids = [...new Set(raw.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
    if (!ids.length) {
        return {
            error: 'ids is required — the cmp_… ids of the components to read.',
            _fixHint: `e.g. { ids: ["cmp_abc123"] }, at most ${MAX_GET_NODES} per call. Ids come from app_get_draft or app_find_nodes.`,
        };
    }
    const wanted = ids.slice(0, MAX_GET_NODES);
    /** @type {Record<string, unknown>[]} */
    const nodes = [];
    /** @type {string[]} */
    const unknownIds = [];
    for (const id of wanted) {
        const found = ops.findNode(draftWrap.def, id);
        if (!found) { unknownIds.push(id); continue; }
        // Everything the node holds (props, style, computed, visibleWhen,
        // events, …) as a copy; children are named by id, not inlined.
        const { children, ...rest } = /** @type {Record<string, any>} */ (structuredClone(found.node));
        nodes.push({ ...rest, ...(Array.isArray(children) && children.length ? { childIds: children.map((/** @type {{ id: string }} */ c) => c.id) } : {}) });
    }
    return {
        nodes,
        ...(unknownIds.length ? { unknownIds, note: 'These ids are not in the draft; call app_find_nodes or app_get_draft for the real ones.' } : {}),
        ...(ids.length > wanted.length ? { skipped: ids.slice(MAX_GET_NODES), truncated: `Only the first ${MAX_GET_NODES} ids are answered per call; ask again for the skipped ones.` } : {}),
    };
}

module.exports = { applyGetNode, MAX_GET_NODES };
