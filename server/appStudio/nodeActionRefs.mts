/**
 * The actions a component node RUNS on a gesture: the one shared reader of
 * "which action does this node fire". Pure.
 *
 * Three consumers used to carry their own copy of this list and had to be kept
 * in step by a parity test: `collectReferencedActions` (validate/nodes.js, the
 * `action.unreachable` rule), `collectActionSites` (automationRefs.js, which button
 * runs an automation) and app_find_nodes (builderTools/findNodesTool.js). All three
 * read it here now, so a new wiring form is added in one place.
 *
 * The order is the document order of the two consumers that came before:
 * events, then the four list props in `ACTION_LIST_PROPS` order (entry order),
 * then `addRowActionId`, then `columns[].actionId`. Children are not visited.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { EVENT_NAMES } = nodeRequire('./componentSpecs') as { EVENT_NAMES: readonly string[] };

/** Props that hold a list of `{ label, actionId }` entries. */
export const ACTION_LIST_PROPS = Object.freeze(['itemActions', 'rowActions', 'bulkActions', 'toolbarActions'] as const);

/** One action a node runs: where it hangs (`via`) and the entry's own label when it has one. */
export type ActionRef = { actionId: string; via: string; label?: string };

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Actions `node` runs, in document order. Non-empty strings only; an
 * unwired or malformed entry is skipped, never thrown on. `via` names the
 * place: an event name, `rowActions[0]`, `addRowActionId`, `columns[2]`.
 */
export function nodeActionRefs(node: unknown): ActionRef[] {
    if (!isObject(node)) return [];
    const out: ActionRef[] = [];
    for (const ev of EVENT_NAMES) {
        const id = node[ev];
        if (typeof id === 'string' && id) out.push({ actionId: id, via: ev });
    }
    const props = isObject(node.props) ? node.props : {};
    for (const key of ACTION_LIST_PROPS) {
        const list = props[key];
        if (!Array.isArray(list)) continue;
        list.forEach((entry, i) => {
            if (!isObject(entry) || typeof entry.actionId !== 'string' || !entry.actionId) return;
            out.push({ actionId: entry.actionId, via: `${key}[${i}]`, ...(typeof entry.label === 'string' && entry.label ? { label: entry.label } : {}) });
        });
    }
    if (typeof props.addRowActionId === 'string' && props.addRowActionId) out.push({ actionId: props.addRowActionId, via: 'addRowActionId' });
    if (Array.isArray(props.columns)) {
        props.columns.forEach((col, i) => {
            if (!isObject(col) || typeof col.actionId !== 'string' || !col.actionId) return;
            out.push({ actionId: col.actionId, via: `columns[${i}]`, ...(typeof col.label === 'string' && col.label ? { label: col.label } : {}) });
        });
    }
    return out;
}
