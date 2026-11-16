/**
 * App Studio builder: regrouping what exists. app_wrap_nodes puts components that sit side by
 * side under one parent into ONE new card or container, at the place of the first of them;
 * app_unwrap_node takes a card or container away and leaves its children where it stood.
 *
 * Without them, "put these four things in one card" was an app_add_components for the card and
 * an app_move_node per component, and a builder asked to make a screen more logical reached for
 * the stylesheet instead (2026-11-16). Ids, wiring and the children's own props stay as they
 * were; only the tree changes, through canonicalize like every edit tool (adoptCanonical).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Node = Obj & { id?: string; type?: string; children?: Node[] };
type Holder = Obj & { id?: string; type?: string; children?: Node[] };
type Def = Obj & { screens?: unknown[] };
type Draft = { def: Def } & Obj;
type Result = Obj & { error?: string; _fixHint?: string; _hints?: string[] };
type Found = { node: Node; parent: Holder; index: number };

const ops = nodeRequire('../definitionOps') as {
    findNode: (def: Def, id: unknown) => Found | null;
    collectIds: (def: Def) => Set<string>;
    uniqueId: (kind: string, taken: Set<string>) => string;
};
const { adoptCanonical } = nodeRequire('./shared') as { adoptCanonical: (d: Draft, next: Def, r: Result) => Result };
const { pickClosestId } = nodeRequire('../../utils/closestId.mts') as { pickClosestId: (id: unknown, all: string[]) => string | null };

export const MAX_WRAP_IDS = 20;
/** What a wrap may make, and what an unwrap may take away: boxes that only group. */
export const WRAP_TYPES: readonly string[] = ['card', 'container'];
const UNWRAP_TYPES: readonly string[] = ['card', 'container', 'pane'];
/** The props a wrapping box may get in the same call (the rest with app_update_component). */
const WRAP_PROPS = ['title', 'description', 'look'];

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function unknownId(def: Def, id: unknown): Result {
    const suggestion = pickClosestId(id, [...ops.collectIds(def)].filter((x) => x.startsWith('cmp_')));
    return { error: `Unknown component id ${JSON.stringify(id ?? null)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: 'Use real cmp_… ids from the draft state (app_get_draft {screenId}).' };
}

function readIds(args: Obj): string[] | Result {
    const ids = args.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_WRAP_IDS || ids.some((id) => typeof id !== 'string' || !id)) {
        return { error: `ids is a list of 1-${MAX_WRAP_IDS} component ids that share one parent.`, _fixHint: 'e.g. { ids: ["cmp_a", "cmp_b"], type: "card", props: { title: "Totals" } }.' };
    }
    if (new Set(ids).size !== ids.length) return { error: 'ids names a component twice.' };
    return ids as string[];
}

/** The wrapping box: the type asked for (card by default), its few props, a span (12 by default). */
function wrapperNode(args: Obj, id: string): Node | Result {
    const type = args.type === undefined ? 'card' : args.type;
    if (typeof type !== 'string' || !WRAP_TYPES.includes(type)) {
        return { error: `type is ${WRAP_TYPES.join(' or ')}.`, _fixHint: 'A card is a visible surface with an optional title; a container groups without chrome (look plain/panel/tinted/outlined).' };
    }
    const props: Obj = {};
    if (isObject(args.props)) for (const key of WRAP_PROPS) if (args.props[key] !== undefined) props[key] = args.props[key];
    const span = isObject(args.style) && typeof args.style.span === 'number' ? args.style.span : 12;
    return { id, type, props, style: { span }, visible: true, children: [] };
}

/** app_wrap_nodes { ids, type?, props?, style? } */
export function applyWrapNodes(draftWrap: Draft, args: unknown): Result {
    const a = isObject(args) ? args : {};
    const ids = readIds(a);
    if (!Array.isArray(ids)) return ids;
    const next = structuredClone(draftWrap.def);
    const found: Found[] = [];
    for (const id of ids) {
        const hit = ops.findNode(next, id);
        if (!hit) return unknownId(next, id);
        found.push(hit);
    }
    const parent = found[0].parent;
    if (found.some((f) => f.parent !== parent)) {
        return {
            error: 'The ids do not share one parent; a wrap only groups components that sit side by side.',
            _fixHint: `Move them under one parent first (app_move_node), then wrap. Their parents: ${found.map((f) => `${String(f.node.id)} in ${String(f.parent.id)}`).join(', ')}.`,
        };
    }
    const built = wrapperNode(a, ops.uniqueId('component', ops.collectIds(next)));
    if ('error' in built) return built as Result;
    const wrapper = built as Node & { children: Node[] };
    const chosen = new Set(ids);
    const siblings = parent.children || [];
    const first = Math.min(...found.map((f) => f.index));
    // The children keep the order they had on screen, whatever order the ids came in.
    wrapper.children = siblings.filter((n) => chosen.has(String(n.id)));
    const rest = siblings.filter((n) => !chosen.has(String(n.id)));
    rest.splice(first, 0, wrapper);
    parent.children = rest;
    return adoptCanonical(draftWrap, next, { wrapped: wrapper.children.map((n) => n.id), containerId: wrapper.id, type: wrapper.type, parentId: parent.id });
}

/** app_unwrap_node { id } */
export function applyUnwrapNode(draftWrap: Draft, args: unknown): Result {
    const a = isObject(args) ? args : {};
    const next = structuredClone(draftWrap.def);
    const hit = ops.findNode(next, a.id);
    if (!hit) return unknownId(next, a.id);
    const { node, parent, index } = hit;
    if (!UNWRAP_TYPES.includes(String(node.type))) {
        return {
            error: `${String(node.id)} is a ${String(node.type)}; only a ${UNWRAP_TYPES.join(', ')} can be unwrapped.`,
            _fixHint: 'A form, tab, modal or repeater gives its children meaning: move single children out with app_move_node instead.',
        };
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const siblings = (parent.children || []).slice();
    siblings.splice(index, 1, ...children);
    parent.children = siblings;
    const result = adoptCanonical(draftWrap, next, { unwrapped: node.id, parentId: parent.id, children: children.map((n) => n.id) });
    if (!result.error && node.onClick) {
        result._hints = [...(result._hints || []), `${String(node.id)} ran ${String(node.onClick)} on a click; that wiring went with it. Bind it to a button with app_bind_action if it is still wanted.`];
    }
    return result;
}
