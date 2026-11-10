import { tryEvaluate } from '@shared/expr/engine.mjs';
import { timersOf, watchersOf } from '@shared/appDefinition/clientTriggers.mjs';
import { useEffect, useMemo, useRef } from 'react';
import { WatcherState } from './watcherState';
import type { ActionSlot } from '../actionRunner/core';

/**
 * The browser host of the client triggers (schema 3, shapes in
 * shared/appDefinition/clientTriggers.mjs): a screen's onOpen and timers, and the app's
 * watchers. Mounted by the live run surface only (pages/apps/AppRunPage.tsx RunBody): the
 * editor canvas, the editor's preview and the headless screenshot entry render AppRenderer
 * without it, so none of them ever fires a trigger.
 */

export type RunSlot = (slot: ActionSlot, opts?: Record<string, unknown>) => Promise<unknown> | unknown;

interface ScreenLike {
    id?: string;
    events?: { onOpen?: unknown };
    timers?: unknown;
}
interface DefinitionLike {
    screens?: unknown;
    watchers?: unknown;
}

function screenOf(definition: DefinitionLike | null | undefined, screenId: string | null): ScreenLike | null {
    const screens = Array.isArray(definition?.screens) ? definition.screens as ScreenLike[] : [];
    return screens.find((s) => s && s.id === screenId) || null;
}

/** The onOpen slot as the runner takes it, or null when the screen has none. */
function openSlot(screen: ScreenLike | null): ActionSlot | null {
    const slot = screen?.events?.onOpen;
    if (typeof slot === 'string' && slot) return slot;
    if (Array.isArray(slot) && slot.length) return slot.filter((id): id is string => typeof id === 'string' && id !== '');
    return null;
}

/**
 * onOpen: once per visit of a screen. A visit is the screen id plus the params it was opened
 * with, so navigating to the same detail screen for another record opens it again; a new
 * render of the same visit (or React's dev double effect) does not.
 */
export function useScreenOpen(definition: DefinitionLike | null | undefined, screenId: string | null, params: unknown, runAction: RunSlot): void {
    const slot = openSlot(screenOf(definition, screenId));
    const slotKey = slot ? JSON.stringify(slot) : '';
    const visit = `${screenId ?? ''}|${JSON.stringify(params ?? {})}`;
    const lastVisit = useRef<string | null>(null);
    const latest = useRef({ slot, runAction });
    useEffect(() => { latest.current = { slot, runAction }; });
    useEffect(() => {
        if (lastVisit.current === visit) return;
        lastVisit.current = visit;
        const current = latest.current;
        if (current.slot) void current.runAction(current.slot, {});
    }, [visit, slotKey]);
}

/** True while the page is in a background tab (or minimised): timers skip their ticks then. */
function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * The screen's timers: every `everySeconds` while the screen is open and the tab visible. A
 * tick is skipped while the timer's previous run is still busy, so a slow action never piles up.
 */
export function useScreenTimers(definition: DefinitionLike | null | undefined, screenId: string | null, runAction: RunSlot): void {
    const timers = useMemo(() => timersOf(screenOf(definition, screenId)), [definition, screenId]);
    const signature = JSON.stringify(timers);
    const run = useRef(runAction);
    useEffect(() => { run.current = runAction; });
    useEffect(() => {
        const list = JSON.parse(signature) as ReturnType<typeof timersOf>;
        const handles = list.map((timer) => {
            let busy = false;
            return setInterval(() => {
                if (busy || pageHidden()) return;
                busy = true;
                Promise.resolve(run.current(timer.actionId, {})).finally(() => { busy = false; });
            }, timer.everySeconds * 1000);
        });
        return () => handles.forEach((h) => clearInterval(h));
    }, [signature]);
}

/**
 * The app's watchers: each formula is evaluated against the live scope on every change of
 * it; a change of the VALUE runs the action once (after debounceMs of quiet when set). A
 * watcher that runs too often is switched off and reported once through `onDisabled`.
 */
export function useWatchers(definition: DefinitionLike | null | undefined, scope: unknown, runAction: RunSlot, onDisabled: (id: string) => void): void {
    const watchers = useMemo(() => watchersOf(definition), [definition]);
    const states = useRef(new Map<string, WatcherState>());
    const timeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const latest = useRef({ runAction, onDisabled });
    useEffect(() => { latest.current = { runAction, onDisabled }; });

    useEffect(() => {
        watchers.forEach((watcher, i) => {
            const key = `${i}:${watcher.id}:${watcher.expr}`;
            let state = states.current.get(key);
            if (!state) { state = new WatcherState(); states.current.set(key, state); }
            if (state.disabled) return;
            const { value } = tryEvaluate(watcher.expr, (scope || {}) as Record<string, unknown>);
            if (state.observe(value) !== 'changed') return;
            const fire = () => {
                timeouts.current.delete(key);
                if (!state.allowRun(Date.now())) {
                    latest.current.onDisabled(watcher.id);
                    return;
                }
                void latest.current.runAction(watcher.actionId, {});
            };
            const pending = timeouts.current.get(key);
            if (pending) clearTimeout(pending);
            if (watcher.debounceMs > 0) timeouts.current.set(key, setTimeout(fire, watcher.debounceMs));
            else fire();
        });
    }, [watchers, scope]);

    useEffect(() => {
        const pending = timeouts.current;
        return () => { pending.forEach((h) => clearTimeout(h)); pending.clear(); };
    }, []);
}
