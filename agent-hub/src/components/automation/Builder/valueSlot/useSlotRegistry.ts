import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { DraggedSource } from './slotDnd';

/**
 * Which field a clicked value goes to.
 *
 * Every field of the open step registers itself here; the field that last
 * had focus is the active one. A click on a value in the source panel goes
 * to the active field, or, when none is active, to the question "Where
 * should this go?" (TargetPopover) with this step's empty fields.
 *
 * A field registers a getLatest() function, not a handle: the registry
 * calls it at the moment a value arrives and so always talks to the field
 * as it is NOW. The old focus handle was a closure made at focus time, so a
 * field that was typed into (or switched to another mode) after it got
 * focus received the value as if it were still empty; the typed text was
 * replaced, or a `{{path}}` was appended to an expression. useRegisterSlot
 * keeps the handle in a ref that every render refreshes.
 */

export interface SlotHandle {
    /** The field key, unique within the step. */
    id: string;
    /** The field's name as the form shows it. */
    label: string;
    required?: boolean;
    /** Does the field hold nothing yet? Read at the moment it is asked. */
    isEmpty: () => boolean;
    /** Put a picked value in the field. */
    accept: (value: DraggedSource) => void;
}

export interface SlotRegistry {
    /** Register a field; returns the function that unregisters it. */
    register: (id: string, getLatest: () => SlotHandle) => () => void;
    /** The field got focus: it is the active one from now on. */
    focus: (id: string) => void;
    /** Forget the active field (the step closed, Escape). */
    clearFocus: () => void;
    /** The active field as it is now, or null. */
    active: () => SlotHandle | null;
    /** The registered fields that are empty now: required ones first, then in form order. */
    emptySlots: () => SlotHandle[];
    /**
     * Hand a picked value to the active field. Returns true when a field took
     * it; false means there is no active field, and the caller asks where it
     * should go (emptySlots).
     */
    deliver: (value: DraggedSource) => boolean;
    /** Hand a picked value to one field by key (the popover's answer). */
    deliverTo: (id: string, value: DraggedSource) => boolean;
}

/** A registry outside React (the hook below keeps one per component). */
export function createSlotRegistry(): SlotRegistry {
    const slots = new Map<string, () => SlotHandle>();
    let focused: string | null = null;

    const get = (id: string | null): SlotHandle | null => {
        if (id === null) return null;
        const getLatest = slots.get(id);
        return getLatest ? getLatest() : null;
    };

    return {
        register(id, getLatest) {
            slots.set(id, getLatest);
            return () => {
                if (slots.get(id) !== getLatest) return;
                slots.delete(id);
                if (focused === id) focused = null;
            };
        },
        focus(id) { if (slots.has(id)) focused = id; },
        clearFocus() { focused = null; },
        active: () => get(focused),
        emptySlots() {
            const handles = [...slots.values()].map(getLatest => getLatest()).filter(h => h.isEmpty());
            // Array.prototype.sort is stable: form order is kept within each group.
            return handles.sort((a, b) => Number(!!b.required) - Number(!!a.required));
        },
        deliver(value) {
            const handle = get(focused);
            if (!handle) return false;
            handle.accept(value);
            return true;
        },
        deliverTo(id, value) {
            const handle = get(id);
            if (!handle) return false;
            focused = id;
            handle.accept(value);
            return true;
        },
    };
}

/** One registry for the lifetime of the component that owns it (the step drawer). */
export function useSlotRegistry(): SlotRegistry {
    const ref = useRef<SlotRegistry | null>(null);
    if (!ref.current) ref.current = createSlotRegistry();
    return ref.current;
}

/** The registry of the open step, for fields deeper in the form. */
export const SlotRegistryContext = createContext<SlotRegistry | null>(null);

export function useSlotRegistryContext(): SlotRegistry | null {
    return useContext(SlotRegistryContext);
}

// The latest handle is stored after every render, before the browser paints,
// so no click can reach an older one. (useEffect where there is no DOM.)
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Register a field. `handle` may be a new object on every render (it closes
 * over the field's current state); the registry reads the latest one through
 * a ref, so it is never stale. Returns `onFocus` for the field's input.
 */
export function useRegisterSlot(registry: SlotRegistry | null, handle: SlotHandle): { onFocus: () => void } {
    const latest = useRef(handle);
    useIsoLayoutEffect(() => { latest.current = handle; });
    const { id } = handle;
    useEffect(() => {
        if (!registry) return undefined;
        return registry.register(id, () => latest.current);
    }, [registry, id]);
    const onFocus = useCallback(() => { registry?.focus(id); }, [registry, id]);
    return { onFocus };
}
