const { PENDING_DATATABLE_RE } = require('../validate/constants');

const MAX_WALK_DEPTH = 60;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {string} id
 */
const isPendingDatatableId = (id) => typeof id === 'string' && PENDING_DATATABLE_RE.test(id);

/**
 * Visit every object that has a string `datatableId`, anywhere in a
 * definition: root, triggers, steps, loop bodies, branch containers, layers
 * and http_request.cacheInto. A deep walk (not a list of known places) so a
 * container added next year is covered too. `visit(obj, scope)` gets the name
 * of the layer the object sits in (null for the root graph).
 * @param {WeakKey} def
 */
function walkDatatableRefs(def, visit) {
    const seen = new WeakSet();
    /**
     * @param {string | null} scope
     * @param {number} depth
     * @param {WeakKey} node
     */
    const walk = (node, scope, depth) => {
        if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) { for (const x of node) walk(x, scope, depth + 1); return; }
        if (typeof node.datatableId === 'string') visit(node, scope);
        for (const [k, v] of Object.entries(node)) {
            if (!v || typeof v !== 'object') continue;
            if (k === 'layers' && isObj(v) && depth <= 1) {
                for (const [name, g] of Object.entries(v)) walk(g, name, depth + 2);
            } else walk(v, scope, depth + 1);
        }
    };
    walk(def, null, 0);
}

/**
 * The REAL table ids the definition points at (what the flow already uses).
 * @param {WeakKey} def
 */
function boundDatatableIds(def) {
    const out = new Set();
    walkDatatableRefs(def, (/** @type {{ datatableId: string; }} */ o) => { if (o.datatableId && !isPendingDatatableId(o.datatableId)) out.add(o.datatableId); });
    return out;
}

module.exports = { isObj, isPendingDatatableId, walkDatatableRefs, boundDatatableIds };
