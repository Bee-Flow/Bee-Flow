/**
 * One flowlet of the automation as if it were the automation — the web's
 * useFlowletScope for the phone's draft store. The view answers the draft
 * store's state with `definition` swapped for `definition.layers[key]` (the
 * root's flowlets alongside, so a call inside it still knows its contract),
 * and every edit made through it is written back into the WHOLE document
 * (model/flowlets setScopedGraph) as one undoable edit of the root: undo,
 * the autosave and the server only ever see complete definitions.
 *
 * An edit that touches `layers` from inside (Create flowlet) lands on the
 * root's map; the flowlet's own graph goes to its entry. Undo, redo, flush,
 * the save state and the lock are the root store's own. Findings stay on the
 * automation's screen: their step ids are the root's.
 */

import type { StoreApi } from 'zustand/vanilla';

import type { DraftOp, DraftState, DraftStore } from './types';
import { getScopedGraph } from '../model/flowlets';
import { normalizeDefinitionShape } from '../model/normalize';
import type { FlowDefinition } from '../model/types';

const NO_FINDINGS = new Map();

/** The flowlet as the editor sees it: its graph, with the root's flowlets beside it. */
export function flowletView(root: FlowDefinition | null, key: string): FlowDefinition | null {
    const graph = getScopedGraph(root, key);
    return graph ? { ...graph, layers: root?.layers } : null;
}

/** An edit of the flowlet's view, as an edit of the whole document. */
export function scopedOp(key: string, op: DraftOp): DraftOp {
    return (root) => {
        const view = flowletView(root, key);
        if (!view) return root;
        const next = normalizeDefinitionShape(op(view));
        if (!next || next === view) return root;
        const { layers, ...graph } = next as FlowDefinition;
        return { ...root, layers: { ...(layers ?? root.layers ?? {}), [key]: graph as FlowDefinition } };
    };
}

function viewOf(state: DraftState, key: string): DraftState {
    return {
        ...state,
        definition: flowletView(state.definition, key),
        baseline: flowletView(state.baseline, key),
        issuesByStep: NO_FINDINGS,
        applyOp: (op) => {
            const written = state.applyOp(scopedOp(key, op));
            return written ? flowletView(written, key) : null;
        },
    };
}

/** A store over one flowlet of `base`; stable per base state, so selectors do not loop. */
export function scopedDraftStore(base: DraftStore, key: string): DraftStore {
    let seen: DraftState | null = null;
    let view: DraftState | null = null;
    const getState = (): DraftState => {
        const s = base.getState();
        if (s !== seen || !view) {
            seen = s;
            view = viewOf(s, key);
        }
        return view;
    };
    const api: StoreApi<DraftState> = {
        getState,
        getInitialState: getState,
        setState: base.setState,
        subscribe: (listener) => {
            let prev = getState();
            return base.subscribe(() => {
                const next = getState();
                if (next !== prev) listener(next, prev);
                prev = next;
            });
        },
    };
    return api;
}
