import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * App Studio runtime — the readable component state behind the formula root `ui`
 * (server/appStudio/componentSpecs/steps/set_ui.js):
 *
 *   ui.tabs.<tabsId>.active   the id of the tab a tabs group shows
 *   ui.modals.<modalId>.open  whether a modal is open
 *   ui.selection.<gridId>     the rows selected in a data_grid (always a list)
 *
 * The components keep their own React state exactly as before; in run mode they
 * also PUBLISH it here and register a SETTER, which the set_ui step calls. A
 * module-level store, like the modal open bus and the reset_form bus: the action
 * runner reaches a mounted component from outside the React tree.
 *
 * Nothing re-renders for it unless something reads it: the renderer and the
 * data scope subscribe (useUiScope) only when the definition mentions `ui.`
 * (definitionReadsUi), so an app that never reads it renders exactly as before.
 */

export type UiStateName = 'activeTab' | 'open' | 'selection';

export interface UiScope {
    tabs: Readonly<Record<string, { active: unknown }>>;
    modals: Readonly<Record<string, { open: boolean }>>;
    selection: Readonly<Record<string, readonly unknown[]>>;
}

type Branch = keyof UiScope;
type Setter = (value: unknown) => void;

const BRANCH: Readonly<Record<UiStateName, Branch>> = Object.freeze({ activeTab: 'tabs', open: 'modals', selection: 'selection' });

const EMPTY_SCOPE: UiScope = Object.freeze({ tabs: Object.freeze({}), modals: Object.freeze({}), selection: Object.freeze({}) });

let snapshot: UiScope = EMPTY_SCOPE;
const listeners = new Set<() => void>();
// `${state}:${nodeId}` → the setters of the mounted instances (a repeater mounts one per row).
const setters = new Map<string, Set<Setter>>();
// `${state}:${nodeId}` → a value set while no instance was mounted; the next one to mount takes it.
const pending = new Map<string, unknown>();
// `${branch}:${nodeId}` → the instance whose value is published (an unmount clears only its own).
const owners = new Map<string, symbol>();

const keyOf = (state: UiStateName, nodeId: string) => `${state}:${nodeId}`;

function notify() {
    for (const fn of [...listeners]) fn();
}

function entryFor(state: UiStateName, value: unknown): unknown {
    if (state === 'activeTab') return { active: value ?? null };
    if (state === 'open') return { open: value === true };
    return Array.isArray(value) ? value : [];
}

function sameEntry(state: UiStateName, a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (state === 'activeTab') return (a as { active: unknown }).active === (b as { active: unknown }).active;
    if (state === 'open') return (a as { open: boolean }).open === (b as { open: boolean }).open;
    // A selection: the same rows in the same order (a grid hands over a new list on every render).
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((row, i) => row === y[i]);
}

/** Publish one component's state (run mode). `owner` is the instance, so its unmount clears only what it wrote. */
export function publishUiState(state: UiStateName, nodeId: string, value: unknown, owner: symbol): void {
    if (!nodeId) return;
    const branch = BRANCH[state];
    const next = entryFor(state, value);
    owners.set(`${branch}:${nodeId}`, owner);
    const current = snapshot[branch] as Record<string, unknown>;
    if (Object.hasOwn(current, nodeId) && sameEntry(state, current[nodeId], next)) return;
    snapshot = { ...snapshot, [branch]: { ...current, [nodeId]: next } };
    notify();
}

/** Forget what `owner` published for this node (its unmount). */
function clearUiState(state: UiStateName, nodeId: string, owner: symbol): void {
    const branch = BRANCH[state];
    const ownerKey = `${branch}:${nodeId}`;
    if (owners.get(ownerKey) !== owner) return;
    owners.delete(ownerKey);
    const current = snapshot[branch] as Record<string, unknown>;
    if (!Object.hasOwn(current, nodeId)) return;
    const { [nodeId]: _gone, ...rest } = current;
    snapshot = { ...snapshot, [branch]: rest };
    notify();
}

/** A mounted instance's setter for set_ui; a value set before it mounted is handed over at once. Returns the cleanup. */
export function registerUiSetter(state: UiStateName, nodeId: string, fn: Setter): () => void {
    if (!nodeId) return () => {};
    const key = keyOf(state, nodeId);
    let set = setters.get(key);
    if (!set) { set = new Set(); setters.set(key, set); }
    set.add(fn);
    if (pending.has(key)) {
        const value = pending.get(key);
        pending.delete(key);
        fn(value);
    }
    return () => {
        set.delete(fn);
        if (set.size === 0) setters.delete(key);
    };
}

/**
 * set_ui for activeTab and selection (a modal's `open` goes through the modal's own
 * open bus). No instance mounted: the value waits for the next one to mount.
 */
export function setUiState(nodeId: string, state: UiStateName, value: unknown): void {
    if (!nodeId) return;
    const key = keyOf(state, nodeId);
    const set = setters.get(key);
    if (!set || set.size === 0) {
        pending.set(key, value);
        return;
    }
    pending.delete(key);
    for (const fn of [...set]) fn(value);
}

/** The current `ui` scope (stable until something changes). */
export function getUiSnapshot(): UiScope {
    return snapshot;
}

function subscribeUi(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SCOPE;

/** The `ui` scope, re-rendering on change, when `enabled`; undefined (and no subscription) otherwise. */
export function useUiScope(enabled: boolean): UiScope | undefined {
    const value = useSyncExternalStore(
        enabled ? subscribeUi : noSubscription,
        enabled ? getUiSnapshot : emptySnapshot,
        enabled ? getUiSnapshot : emptySnapshot,
    );
    return enabled ? value : undefined;
}

const isIdentChar = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c === '.';

/** Does this text name the root `ui` (as `ui.`, not as the tail of another name such as `gui.` or `a.ui.`)? */
export function mentionsUiRoot(text: string): boolean {
    for (let i = text.indexOf('ui.'); i !== -1; i = text.indexOf('ui.', i + 1)) {
        if (i === 0 || !isIdentChar(text[i - 1])) return true;
    }
    return false;
}

const readsCache = new WeakMap<object, boolean>();

/**
 * Does anything in the definition read the `ui` root? A text scan of the whole
 * definition, cached per definition object. A false positive only costs a
 * subscription; a definition that never mentions `ui.` never subscribes.
 */
export function definitionReadsUi(definition: unknown): boolean {
    if (!definition || typeof definition !== 'object') return false;
    const cached = readsCache.get(definition);
    if (cached !== undefined) return cached;
    let reads = false;
    try { reads = mentionsUiRoot(JSON.stringify(definition)); } catch { reads = false; }
    readsCache.set(definition, reads);
    return reads;
}

/**
 * A component's side of it: publishes `value` (which must keep its identity while
 * it is unchanged) and lets set_ui call `apply` (null: the component has its own
 * way in, like the modal's open bus). Off when `enabled` is false (the editor
 * canvas), so the component then behaves exactly as it did before.
 */
export function usePublishedUiState(state: UiStateName, nodeId: string | null | undefined, value: unknown, apply: Setter | null, enabled: boolean): void {
    const [owner] = useState(() => Symbol(state));
    const applyRef = useRef(apply);
    useLayoutEffect(() => { applyRef.current = apply; });
    const settable = apply !== null;
    useEffect(() => {
        if (enabled && nodeId) publishUiState(state, nodeId, value, owner);
    }, [enabled, nodeId, state, value, owner]);
    useEffect(() => {
        if (!enabled || !nodeId) return undefined;
        const unregister = settable ? registerUiSetter(state, nodeId, (v) => applyRef.current?.(v)) : () => {};
        return () => {
            unregister();
            clearUiState(state, nodeId, owner);
        };
    }, [enabled, nodeId, state, owner, settable]);
}

/** Tests only: forget every published value, setter and pending value. */
export function resetUiStateForTests(): void {
    snapshot = EMPTY_SCOPE;
    setters.clear();
    pending.clear();
    owners.clear();
    notify();
}
