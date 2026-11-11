import { CLIENT_TRIGGER_LIMITS, slotActionIds, slotFromIds } from '@shared/appDefinition/clientTriggers.mjs';
import type { AppDefinition, AppScreen } from '../inspector/appDefinition';

/**
 * The editor's ops on the client triggers of schema 3 (shapes in
 * shared/appDefinition/clientTriggers.mjs): a screen's onOpen and timers, the app's
 * watchers. Pure, like the rest of state/: each returns a new definition, or the same one
 * when nothing changed. An empty list or object REMOVES its key, so a screen or app that
 * ends up without triggers is stored exactly like one that never had any.
 */

export interface ScreenTimer { id: string; everySeconds: number; actionId: string }
export interface Watcher { id: string; expr: string; actionId: string; debounceMs?: number }
export type OpenSlot = string | string[] | null;

export const TRIGGER_LIMITS = CLIENT_TRIGGER_LIMITS;

function patchScreen(def: AppDefinition, screenId: string, patch: (screen: AppScreen) => AppScreen): AppDefinition {
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return def;
    const next = patch(screens[idx]);
    if (next === screens[idx]) return def;
    const out = screens.slice();
    out[idx] = next;
    return { ...def, screens: out };
}

/** The screen's onOpen: one action id, a list (run in order), or null to remove it. */
export function setScreenOpen(def: AppDefinition, screenId: string, slot: OpenSlot): AppDefinition {
    return patchScreen(def, screenId, (screen) => {
        const value = slotFromIds(slotActionIds(slot));
        const { events: _old, ...rest } = screen;
        if (value === undefined) return screen.events === undefined ? screen : rest;
        return { ...rest, events: { onOpen: value } };
    });
}

/** The screen's timers, as a whole list; [] removes them. */
export function setScreenTimers(def: AppDefinition, screenId: string, timers: ScreenTimer[]): AppDefinition {
    return patchScreen(def, screenId, (screen) => {
        const { timers: _old, ...rest } = screen;
        if (!timers.length) return screen.timers === undefined ? screen : rest;
        return { ...rest, timers: timers.map((t) => ({ id: t.id, everySeconds: t.everySeconds, actionId: t.actionId })) };
    });
}

/** The app's watchers, as a whole list; [] removes the key. */
export function setWatchers(def: AppDefinition, watchers: Watcher[]): AppDefinition {
    const { watchers: _old, ...rest } = def;
    if (!watchers.length) return def.watchers === undefined ? def : rest;
    return {
        ...rest,
        watchers: watchers.map((w) => ({ id: w.id, expr: w.expr, actionId: w.actionId, ...(w.debounceMs ? { debounceMs: w.debounceMs } : {}) })),
    };
}

/** The first `<prefix><n>` not in `taken`. */
export function nextTriggerId(prefix: string, taken: Array<{ id?: string }>): string {
    const ids = new Set(taken.map((t) => t.id));
    let n = 1;
    while (ids.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
}

/** The screen's timers as stored (a malformed list reads as none). */
export function screenTimers(screen: AppScreen | null | undefined): ScreenTimer[] {
    return Array.isArray(screen?.timers) ? (screen.timers as ScreenTimer[]).filter((t) => t && typeof t === 'object') : [];
}

/** The app's watchers as stored. */
export function definitionWatchers(def: AppDefinition | null | undefined): Watcher[] {
    return Array.isArray(def?.watchers) ? (def.watchers as Watcher[]).filter((w) => w && typeof w === 'object') : [];
}

/** Every screen trigger and watcher that named a deleted action, without it (removeAction calls this). */
export function withoutTriggerAction(def: AppDefinition, actionId: string): AppDefinition {
    let out = def;
    for (const screen of def.screens || []) {
        const open = (screen.events as { onOpen?: unknown } | undefined)?.onOpen;
        if (slotActionIds(open).includes(actionId)) out = setScreenOpen(out, screen.id, slotActionIds(open).filter((id) => id !== actionId));
        const timers = screenTimers(screen);
        if (timers.some((t) => t.actionId === actionId)) out = setScreenTimers(out, screen.id, timers.filter((t) => t.actionId !== actionId));
    }
    const watchers = definitionWatchers(out);
    if (watchers.some((w) => w.actionId === actionId)) out = setWatchers(out, watchers.filter((w) => w.actionId !== actionId));
    return out;
}
