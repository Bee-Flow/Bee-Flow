/**
 * How a cowork starts. The clock ('schedule') and a new mail ('app_event', ./mailTriggerRun.mts) are the first two;
 * version 2.1 adds four, each an event that hands the run its own data:
 *
 *   after_cowork  another cowork of the same owner ended well: its title and what it produced
 *   webhook       another system called the item's own address: the JSON it sent
 *   row           rows of a datatable the owner can read changed: which table, and its version
 *   file          a new file arrived in a Nextcloud folder: the file's name and path
 *
 * Every event's data is OUTSIDE TEXT (ADR 0031): it may fill content, never a recipient, a target or an address. A
 * plan that starts on one is therefore checked as a plan whose trigger brings outside text (asStartedBy), and an
 * agent run that starts on one is marked as having read outside text from its first step (./runActivity.mts).
 */

import type { Definition } from './plan/planTypes.mts';

export type StartKind = 'schedule' | 'app_event' | 'after_cowork' | 'webhook' | 'row' | 'file';
export const EVENT_STARTS: readonly StartKind[] = Object.freeze(['after_cowork', 'webhook', 'row', 'file']);

export const isEventStart = (kind: unknown): kind is StartKind => typeof kind === 'string' && (EVENT_STARTS as readonly string[]).includes(kind);

/** Anything but the clock hands the run data from outside: a mail, a call, a row, a file, another run's result. */
export const startsWithOutsideText = (kind: unknown): boolean => kind === 'app_event' || isEventStart(kind);

/**
 * The plan as the checks must read it for an item that starts this way: its trigger is one that brings outside text,
 * so `{{trigger.output...}}` is followed through the plan like the text of a mail (./plan/outsideText.mts). The
 * definition itself, and so its fingerprint, is not changed.
 */
export function asStartedBy(definition: Definition, item: { triggerKind?: string | null }): Definition {
    if (!startsWithOutsideText(item.triggerKind)) return definition;
    const trigger = definition.trigger && typeof definition.trigger === 'object' ? definition.trigger : {};
    return { ...definition, trigger: { ...trigger, kind: 'webhook' } };
}
