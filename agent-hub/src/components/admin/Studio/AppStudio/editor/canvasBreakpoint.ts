/**
 * App Studio editor: which screen size the canvas is being arranged for.
 *
 * A node has one width per size: `span` on a desktop, `spanMd` on a tablet, `spanSm` on a
 * phone. The switch on the canvas (BreakpointSwitch) picks the size; the width grip then
 * writes that size's knob and every cell shows the width it has at that size
 * (nodeWrapper/useNodeResize, runtime effectiveSpan). 'lg' is the desktop and the start
 * value, and with it the canvas is exactly what it was before the switch existed.
 *
 * One value for the one editor a tab shows, kept outside React so the canvas cells and the
 * switch read it without a provider around them.
 */
import { useSyncExternalStore } from 'react';
import type { Breakpoint } from '../runtime/styleResolver';

const BREAKPOINTS: readonly Breakpoint[] = ['lg', 'md', 'sm'];

/** The style knob a width drag writes at each size. */
export const SPAN_KNOB: Readonly<Record<Breakpoint, 'span' | 'spanMd' | 'spanSm'>> = { lg: 'span', md: 'spanMd', sm: 'spanSm' };

let current: Breakpoint = 'lg';
const listeners = new Set<() => void>();

export function getCanvasBreakpoint(): Breakpoint {
    return current;
}

export function setCanvasBreakpoint(next: Breakpoint): void {
    if (!BREAKPOINTS.includes(next) || next === current) return;
    current = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useCanvasBreakpoint(): Breakpoint {
    return useSyncExternalStore(subscribe, getCanvasBreakpoint, getCanvasBreakpoint);
}
