import { CLIENT_TRIGGER_LIMITS, slotActionIds, slotFromIds } from '@shared/appDefinition/clientTriggers.mjs';

/**
 * The editor's edits of one event slot (schema 3: a slot holds one action id, or a list of
 * up to MAX_ACTIONS_PER_EVENT that run in order and stop at the first that fails).
 *
 * The FIRST id is the slot's own action: the inspector edits it inline, exactly as it did
 * when a slot held one id. The others are "then also run" entries, picked from the app's
 * actions. Every helper returns what the slot should hold: a plain string for one id (so a
 * slot nobody extended keeps its bytes), a list for more, null for none.
 */

export type SlotValue = string | string[] | null;

export const MAX_ACTIONS_PER_EVENT: number = CLIENT_TRIGGER_LIMITS.MAX_ACTIONS_PER_EVENT;

/** The ids of a slot in run order. */
export function slotIds(slot: unknown): string[] {
    return slotActionIds(slot);
}

function slotOf(ids: string[]): SlotValue {
    return (slotFromIds(ids) as SlotValue | undefined) ?? null;
}

/** The slot with its own (first) action replaced; null clears the whole slot, as before. */
export function withFirst(slot: unknown, id: string | null): SlotValue {
    if (!id) return null;
    const ids = slotIds(slot);
    return slotOf([id, ...ids.slice(1)]);
}

/** The slot with one more action at the end, when there is room. */
export function withAdded(slot: unknown, id: string): SlotValue {
    const ids = slotIds(slot);
    if (!id || ids.length >= MAX_ACTIONS_PER_EVENT) return slotOf(ids);
    return slotOf([...ids, id]);
}

/** The slot with the action at `index` (1 or more: the first one is edited inline) replaced. */
export function withReplaced(slot: unknown, index: number, id: string): SlotValue {
    const ids = slotIds(slot);
    if (index < 1 || index >= ids.length || !id) return slotOf(ids);
    ids[index] = id;
    return slotOf(ids);
}

/** The slot without the action at `index`. */
export function withRemoved(slot: unknown, index: number): SlotValue {
    const ids = slotIds(slot);
    if (index < 0 || index >= ids.length) return slotOf(ids);
    ids.splice(index, 1);
    return slotOf(ids);
}

/** The slot without every occurrence of `actionId` (a deleted action). */
export function withoutAction(slot: unknown, actionId: string | null): SlotValue {
    return slotOf(slotIds(slot).filter((id) => id !== actionId));
}

/** True when the slot names `actionId`. */
export function slotHas(slot: unknown, actionId: string | null): boolean {
    return !!actionId && slotIds(slot).includes(actionId);
}
