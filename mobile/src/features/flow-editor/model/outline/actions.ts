/**
 * What a card's menu offers — the web card's action chrome (StepNodeBase:
 * run-to-here, duplicate, disconnect, pin, delete) and its right-click menu
 * (NodeContextMenu), on the same conditions, the call node's "Open flowlet",
 * plus the outline's own Move up /
 * Move down, Disable / Enable (the web node editor's switch), and "Run from here" (the step editor's retry-from-here, the
 * server's `mode: 'from'`). Pure: which actions, and whether each can run now.
 */

import { canDeleteNode, canDetachNode, canDuplicateNode, type FlowDefinition } from '..';
import { canMove, isDisabled, isPinned } from './edits';
import { findAtAddress, isNestedAddress } from './nested';
import type { RunRow } from './types';

export type StepActionId =
    | 'open' | 'openFlowlet' | 'test' | 'runUpTo' | 'runFrom' | 'duplicate' | 'moveUp' | 'moveDown' | 'pin' | 'unpin' | 'disable' | 'enable'
    | 'detach' | 'delete' | 'addTrigger';

export interface StepAction {
    id: StepActionId;
    enabled: boolean;
}

function isTrigger(def: FlowDefinition, id: string): boolean {
    return def.trigger?.id === id || (def.triggers || []).some((t) => t?.id === id);
}

/** Pin needs a captured output to freeze (or an existing pin to release); never a trigger. */
function pinAction(def: FlowDefinition, address: string, run: RunRow | null): StepAction | null {
    const step = findAtAddress(def, address);
    if (!step) return null;
    if (isPinned(step)) return { id: 'unpin', enabled: true };
    const pinnable = !!run && run.output !== undefined && run.status !== 'pinned';
    return pinnable ? { id: 'pin', enabled: true } : null;
}

/** A call_layer whose flowlet is in the automation: its card opens the flowlet (the web node's "Open flowlet"). */
function callsFlowlet(def: FlowDefinition, address: string): boolean {
    const step = findAtAddress(def, address);
    const key = step?.type === 'call_layer' ? step.layerKey : null;
    return typeof key === 'string' && !!def.layers?.[key];
}

/** Disable / Enable: any step but a note (a trigger never reaches here). */
function disableAction(def: FlowDefinition, address: string): StepActionId | null {
    const step = findAtAddress(def, address);
    if (!step || step.type === 'note') return null;
    return isDisabled(step) ? 'enable' : 'disable';
}

/** A step's own edits (never a trigger's): duplicate, move, pin, switch off. */
function stepEdits(def: FlowDefinition, address: string, run: RunRow | null): StepAction[] {
    const out: StepAction[] = [
        { id: 'duplicate', enabled: isNestedAddress(address) || canDuplicateNode(def, address) },
        { id: 'moveUp', enabled: canMove(def, address, 'up') },
        { id: 'moveDown', enabled: canMove(def, address, 'down') },
    ];
    const pin = pinAction(def, address, run);
    if (pin) out.push(pin);
    const onOff = disableAction(def, address);
    if (onOff) out.push({ id: onOff, enabled: true });
    return out;
}

/**
 * Open (and open its flowlet), then the test runs a top-level step offers —
 * shown but waiting while a run is out: a second one is not started then,
 * and a menu entry that silently does nothing reads as broken.
 */
function openActions(def: FlowDefinition, address: string, runs: boolean, running: boolean): StepAction[] {
    const out: StepAction[] = [{ id: 'open', enabled: true }];
    if (callsFlowlet(def, address)) out.push({ id: 'openFlowlet', enabled: true });
    if (runs) out.push({ id: 'test', enabled: !running }, { id: 'runUpTo', enabled: !running }, { id: 'runFrom', enabled: !running });
    return out;
}

interface MenuOptions {
    run?: RunRow | null;
    /** The AI is building: every edit waits. */
    locked?: boolean;
    /** This screen runs tests (a flowlet's does not). */
    canRun?: boolean;
    /** A test is out: the run entries wait. */
    running?: boolean;
    /** The primary trigger's card offers another trigger (not in a flowlet). */
    addTrigger?: boolean;
}

/** The edits after Open and the runs: another trigger, the step's own edits, disconnect, delete. */
function editActions(def: FlowDefinition, address: string, where: { trigger: boolean; nested: boolean }, opts: MenuOptions): StepAction[] {
    const { trigger, nested } = where;
    const edit = (id: StepActionId, ok: boolean): StepAction => ({ id, enabled: ok && !opts.locked });
    const out: StepAction[] = [];
    // The Steps view's way to a second trigger: a "+" between steps no longer offers one.
    if (opts.addTrigger && trigger && def.trigger?.id === address) out.push(edit('addTrigger', true));
    if (!trigger) out.push(...stepEdits(def, address, opts.run ?? null).map((a) => edit(a.id, a.enabled)));
    if (!trigger && !nested && canDetachNode(def, address)) out.push(edit('detach', true));
    if (nested || canDeleteNode(def, address)) out.push(edit('delete', true));
    return out;
}

/**
 * The menu for the card at `address`, in the order it is shown. `locked`
 * (the AI is building) disables every edit; opening and testing stay.
 */
export function stepActions(def: FlowDefinition, address: string, opts: MenuOptions = {}): StepAction[] {
    const nested = isNestedAddress(address);
    const trigger = !nested && isTrigger(def, address);
    const runs = !trigger && !nested && (opts.canRun ?? true);
    return [...openActions(def, address, runs, !!opts.running), ...editActions(def, address, { trigger, nested }, opts)];
}
