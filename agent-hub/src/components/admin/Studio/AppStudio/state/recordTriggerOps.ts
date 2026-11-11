import type { ServerTrigger } from './serverTriggerOps';

/**
 * The editor's ops on a record trigger (definition.triggers, kind "record"; the server's rules are
 * server/appStudio/triggers/kinds/record.mts and recordTriggerRule.mts). Pure: each returns a new
 * trigger. The list itself is written with setTriggers of serverTriggerOps, so the triggers of
 * every kind stay one list in one order.
 */

export const RECORD_EVENTS = ['create', 'update', 'delete'] as const;
export type RecordEvent = typeof RECORD_EVENTS[number];

export interface RecordTrigger extends ServerTrigger {
    kind: 'record';
    tableId: string;
    on: RecordEvent[];
    fields?: string[];
    when?: string;
    allowPublicWrites?: true;
}

export const isRecordTrigger = (t: ServerTrigger): t is RecordTrigger => t.kind === 'record';

/** A new record trigger on `tableId` for `actionId`: on every added row, with the first free `trigger<n>` id. */
export function newRecordTrigger(taken: ServerTrigger[], actionId: string, tableId: string): RecordTrigger {
    const ids = new Set(taken.map((t) => t.id));
    let n = 1;
    while (ids.has(`trigger${n}`)) n++;
    return { id: `trigger${n}`, kind: 'record', actionId, tableId, on: ['create'] };
}

/** Another table: the watched fields belonged to the old one and go. */
export function withTable(trigger: RecordTrigger, tableId: string): RecordTrigger {
    if (tableId === trigger.tableId) return trigger;
    const { fields: _old, ...rest } = trigger;
    return { ...rest, tableId };
}

/** Switch one event on or off; the last one stays on (a trigger listens to something). Fields only narrow `update`. */
export function withEvent(trigger: RecordTrigger, event: RecordEvent, on: boolean): RecordTrigger {
    const next = RECORD_EVENTS.filter((e) => (e === event ? on : trigger.on.includes(e)));
    if (!next.length) return trigger;
    if (next.includes('update')) return { ...trigger, on: next };
    const { fields: _old, ...rest } = trigger;
    return { ...rest, on: next };
}

/** Watch a field, or stop watching it; no field left removes the list (any field counts again). */
export function withField(trigger: RecordTrigger, field: string, watched: boolean): RecordTrigger {
    const { fields: old = [], ...rest } = trigger;
    const next = watched ? [...old.filter((f) => f !== field), field] : old.filter((f) => f !== field);
    return next.length ? { ...rest, fields: next } : rest;
}

/** The condition; an empty one removes it. */
export function withWhen(trigger: RecordTrigger, when: string): RecordTrigger {
    const { when: _old, ...rest } = trigger;
    return when.trim() ? { ...rest, when } : rest;
}

/** `allowPublicWrites` is only stored as true. */
export function withAllowPublic(trigger: RecordTrigger, allow: boolean): RecordTrigger {
    const { allowPublicWrites: _old, ...rest } = trigger;
    return allow ? { ...rest, allowPublicWrites: true } : rest;
}
