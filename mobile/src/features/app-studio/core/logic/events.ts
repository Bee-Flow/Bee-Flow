/**
 * Which events a component type may carry, and how each event reads.
 *
 * TYPE_EVENT_LISTS is the web's (inspector/styleKnobMeta.js), a mirror of
 * each type's `events` in the server's COMPONENT_SPECS; eventText is the
 * web's (editor/nodeLogicSummary.js) and borrows its keys, which exist in both
 * dictionaries. Pinned by logicRows.lockstep.test.ts.
 */

import type { Translate } from '../msg';
import { NODE_EVENTS } from '../ops';
import type { AppNode } from '../types';

export const TYPE_EVENT_LISTS: Readonly<Record<string, readonly string[]>> = {
    button: ['onClick'],
    list: ['onRowClick'],
    form: ['onSubmit'],
    data_grid: ['onRowClick', 'onRowSelect'],
    timeline: ['onRowClick'],
    stepper: ['onRowClick'],
    file_gallery: ['onRowClick'],
    badge_list: ['onRowClick'],
    input_select: ['onChange'],
    input_checkbox: ['onChange'],
    input_date: ['onChange'],
    input_multiselect: ['onChange'],
    input_file: ['onChange'],
    input_dataset: ['onChange'],
    message_thread: ['onRowClick'],
    kanban: ['onRowClick', 'onCardMove'],
    calendar: ['onRowClick'],
    chart: ['onRowClick'],
    approval_list: ['onDecided'],
};

/** An event slot, in the words a person reads it in. An unknown slot reads as its name. */
export function eventText(t: Translate, event: string): string {
    switch (event) {
        case 'onClick': return t('app_studio.inspector.when_clicked', 'When clicked');
        case 'onSubmit': return t('app_studio.inspector.when_submitted', 'When submitted');
        case 'onRowClick': return t('app_studio.inspector.when_row_clicked', 'When a row is clicked');
        case 'onRowSelect': return t('app_studio.inspector.when_row_selected', 'When a row is selected');
        case 'onCardMove': return t('app_studio.inspector.when_card_moved', 'When a card is moved');
        case 'onChange': return t('app_studio.inspector.when_changed', 'When it changes');
        case 'onDecided': return t('app_studio.inspector.when_decided', 'When a decision is made');
        default: return event;
    }
}

/** Which events this component type may carry; empty for a type without events. */
export function eventsForType(type: unknown): string[] {
    const list = typeof type === 'string' && Object.prototype.hasOwnProperty.call(TYPE_EVENT_LISTS, type)
        ? TYPE_EVENT_LISTS[type]
        : undefined;
    return Array.isArray(list) ? list.slice() : [];
}

/**
 * The event slots of THIS node: what its type may carry, plus every slot that
 * is actually wired on it (a wired slot outside the type list must not vanish
 * from the Logic table). Type order first, extras after.
 */
export function eventSlotsOf(node: AppNode | null | undefined): string[] {
    const slots = eventsForType(node?.type);
    for (const event of NODE_EVENTS) {
        if (slots.includes(event)) continue;
        const wired = node?.[event];
        if (typeof wired === 'string' && wired) slots.push(event);
    }
    return slots;
}

/** `t()` for a counted phrase: the base key for one, `<key>_plural` for any other count. */
export function nOf(t: Translate, key: string, count: unknown, forms: { one: string; many: string }): string {
    const n = Number(count) || 0;
    return n === 1 ? t(key, forms.one, { count: n }) : t(`${key}_plural`, forms.many, { count: n });
}
