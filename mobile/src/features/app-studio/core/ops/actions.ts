/**
 * Action ops, and the reference clean-ups a removal needs.
 *
 * Port of the "Action ops" block of definitionOps.js plus the reference
 * strippers removeNode and removeScreen share with it. A dangling action,
 * dialog or screen reference is a hard validation error server-side (every
 * later save 422s), so a removal takes its references with it.
 */

import type { AppAction, AppDefinition, AppNode, NodeEvent } from '../types';
import { uniqueId } from './ids';
import { mapActions, stripSteps } from './steps';
import { collectIds, mapAllNodes } from './tree';

/** The full event vocabulary a node may carry (EVENT_NAMES in componentSpecs.js). */
export const NODE_EVENTS: readonly NodeEvent[] = [
    'onClick',
    'onSubmit',
    'onRowClick',
    'onRowSelect',
    'onCardMove',
    'onChange',
    'onDecided',
];

/** The four list surfaces that name an action per entry (collectReferencedActions order). */
export const NODE_ACTION_LISTS = ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions'] as const;

/** Upsert an action; a null/undefined id creates one. Returns { def, actionId }. */
export function setAction<D extends AppDefinition>(
    def: D,
    actionIdOrNull: string | null | undefined,
    action: AppAction | null | undefined,
): { def: D; actionId: string | null } {
    if (!action || typeof action !== 'object') return { def, actionId: null };
    const actionId = actionIdOrNull || uniqueId('action', collectIds(def));
    return { def: { ...def, actions: { ...(def.actions || {}), [actionId]: action } }, actionId };
}

type Props = Record<string, unknown>;
type Entry = { actionId?: unknown } | null | undefined;

function stripLists(props: Props, next: Props, actionId: string): boolean {
    let dirty = false;
    for (const key of NODE_ACTION_LISTS) {
        const list = Array.isArray(props[key]) ? (props[key] as Entry[]) : null;
        if (!list || !list.some((e) => e && e.actionId === actionId)) continue;
        next[key] = list.filter((e) => !e || e.actionId !== actionId);
        dirty = true;
    }
    return dirty;
}

function stripColumns(props: Props, next: Props, actionId: string): boolean {
    const columns = Array.isArray(props.columns) ? (props.columns as Entry[]) : null;
    if (!columns || !columns.some((c) => c && c.actionId === actionId)) return false;
    next.columns = columns.map((col) => {
        if (!col || col.actionId !== actionId) return col;
        const { actionId: _gone, ...rest } = col;
        return rest;
    });
    return true;
}

/**
 * A node's six action surfaces without this action, or null when nothing
 * pointed at it. A list entry goes entirely (a row button without an action
 * does nothing); a column stays and loses only its action.
 */
function propsWithoutAction(props: unknown, actionId: string): Props | null {
    if (!props || typeof props !== 'object') return null;
    const source = props as Props;
    const next: Props = { ...source };
    let dirty = stripLists(source, next, actionId);
    if (source.addRowActionId === actionId) {
        delete next.addRowActionId;
        dirty = true;
    }
    if (stripColumns(source, next, actionId)) dirty = true;
    return dirty ? next : null;
}

/** Remove an action and strip every reference to it a node can carry. */
export function removeAction<D extends AppDefinition>(def: D, actionId: string): D {
    if (!def.actions || !(actionId in def.actions)) return def;
    const actions = { ...def.actions };
    delete actions[actionId];
    return mapAllNodes({ ...def, actions }, (node: AppNode) => {
        const events = NODE_EVENTS.filter((ev) => node[ev] === actionId);
        const props = propsWithoutAction(node.props, actionId);
        if (!events.length && !props) return node;
        const copy: AppNode = { ...node };
        for (const ev of events) delete copy[ev];
        if (props) copy.props = props;
        return copy;
    });
}

const isModalKind = (kind: unknown) => kind === 'open_modal' || kind === 'close_modal';

/** Drop every action reference to a dialog that is no longer there. */
export function stripModalRefs<D extends AppDefinition>(def: D, modalId: string): D {
    let next = def;
    for (const [actionId, action] of Object.entries(next.actions || {})) {
        if (action && isModalKind(action.kind) && action.modalId === modalId) next = removeAction(next, actionId);
    }
    const drop = (step: { kind: string; [k: string]: unknown }) => isModalKind(step.kind) && step.modalId === modalId;
    const actions = mapActions(next.actions, (action) => {
        const steps = stripSteps(action.steps, drop);
        return steps !== action.steps ? { ...action, steps } : action;
    });
    return actions !== next.actions ? { ...next, actions: actions as D['actions'] } : next;
}

function withoutNavigateTo(action: AppAction, screenId: string): AppAction {
    let copy = action;
    for (const slot of ['onSuccess', 'onError'] as const) {
        const effects = copy[slot];
        if (effects && typeof effects === 'object' && (effects as Props).navigateTo === screenId) {
            const { navigateTo: _gone, ...rest } = effects as Props;
            copy = { ...copy, [slot]: rest };
        }
    }
    return copy;
}

/** Strip effects' navigateTo and sequence navigate steps aimed at `screenId`. */
export function stripScreenRefs(
    actions: Record<string, AppAction> | undefined,
    screenId: string,
): Record<string, AppAction> | undefined {
    const drop = (step: { kind: string; [k: string]: unknown }) => step.kind === 'navigate' && step.screenId === screenId;
    return mapActions(actions, (action) => {
        const copy = withoutNavigateTo(action, screenId);
        const steps = stripSteps(copy.steps, drop);
        return steps !== copy.steps ? { ...copy, steps } : copy;
    });
}
