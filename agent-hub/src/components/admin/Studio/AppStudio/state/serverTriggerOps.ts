import type { AppDefinition } from '../inspector/appDefinition';

/**
 * The editor's ops on the server triggers of schema 3 (definition.triggers; the server's rules
 * are server/appStudio/triggers/). Pure, like the rest of state/: each returns a new definition,
 * or the same one when nothing changed. An empty list REMOVES the key, so an app that ends up
 * without triggers is stored exactly like one that never had any.
 */

export type TriggerSchedule = { cron: string; tz: string } | { everyMinutes: number };
export interface ServerTrigger { id: string; kind: string; actionId: string; schedule?: TriggerSchedule; enabled?: false; [key: string]: unknown }

/** Triggers in one app (MAX_TRIGGERS in server/appStudio/triggers/triggerSpec.mts). */
export const MAX_SERVER_TRIGGERS = 20;
/** The longest interval: one year in minutes. */
export const MAX_EVERY_MINUTES = 525_600;

/** The app's triggers as stored (a malformed list reads as none). */
export function definitionTriggers(def: AppDefinition | null | undefined): ServerTrigger[] {
    return Array.isArray(def?.triggers) ? (def.triggers as ServerTrigger[]).filter((t) => t && typeof t === 'object') : [];
}

/** The app's triggers, as a whole list; [] removes the key. */
export function setTriggers(def: AppDefinition, triggers: ServerTrigger[]): AppDefinition {
    const { triggers: _old, ...rest } = def;
    if (!triggers.length) return def.triggers === undefined ? def : rest;
    return { ...rest, triggers };
}

/** A new schedule trigger for `actionId`: every hour, with the first free `trigger<n>` id. */
export function newScheduleTrigger(taken: ServerTrigger[], actionId: string): ServerTrigger {
    const ids = new Set(taken.map((t) => t.id));
    let n = 1;
    while (ids.has(`trigger${n}`)) n++;
    return { id: `trigger${n}`, kind: 'schedule', actionId, schedule: { everyMinutes: 60 } };
}

/** `enabled` is only stored as false. */
export function withEnabled(trigger: ServerTrigger, enabled: boolean): ServerTrigger {
    const { enabled: _old, ...rest } = trigger;
    return enabled ? rest : { ...rest, enabled: false };
}

export const isInterval = (s: TriggerSchedule | undefined): s is { everyMinutes: number } => !!s && 'everyMinutes' in s;

/** A whole number of minutes from 1 to a year, from what was typed. */
export function clampMinutes(raw: string): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_EVERY_MINUTES);
}
