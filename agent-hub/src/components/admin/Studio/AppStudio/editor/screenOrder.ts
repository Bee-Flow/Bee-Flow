import { useState } from 'react';
import { moveScreen } from '../state/structureOps';
import type { DragEvent, HTMLAttributes } from 'react';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * Reordering screens by dragging their tabs (ScreenTabs).
 *
 * Native HTML drag and drop, not dnd-kit: the tabs are also dnd-kit DROP targets for canvas
 * components (dragging a component onto a tab moves it to that screen), and a second dnd-kit
 * draggable in the same context would compete with that. A native drag carries its own data
 * type, so a file or a canvas drag never reads as a screen drag.
 */

/** The data type a tab drag carries. */
export const SCREEN_DRAG_TYPE = 'application/x-beeflow-screen';

/** Where a tab dragged from `from` lands when dropped on tab `over`'s near (before) or far half (after). */
export function reorderTarget(from: number, over: number, after: boolean): number {
    const to = after ? over + 1 : over;
    return from < to ? to - 1 : to;
}

export interface ScreenDropHint {
    screenId: string;
    after: boolean;
}

/** Was this drag started on a screen tab? */
const isScreenDrag = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types || []).includes(SCREEN_DRAG_TYPE);

/**
 * Drag props per tab, and the drop hint to draw. `commit` gets the reordered definition (the
 * shared moveScreen op), or nothing when the drop lands where the tab already was.
 */
export function useScreenDrag(definition: AppDefinition | null, commit: ((def: AppDefinition) => void) | undefined, disabled: boolean) {
    const [dragId, setDragId] = useState<string | null>(null);
    const [hint, setHint] = useState<ScreenDropHint | null>(null);
    const screens = definition?.screens || [];

    const end = () => {
        setDragId(null);
        setHint(null);
    };
    const drop = (overId: string, after: boolean) => {
        const from = screens.findIndex((s) => s.id === dragId);
        const over = screens.findIndex((s) => s.id === overId);
        end();
        if (!definition || from === -1 || over === -1 || !dragId) return;
        const next = moveScreen(definition, dragId, reorderTarget(from, over, after));
        if (next !== definition) commit?.(next);
    };
    const sideOf = (e: DragEvent<HTMLElement>): boolean => {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientX > rect.left + rect.width / 2;
    };

    const tabDragProps = (screenId: string, enabled = true): HTMLAttributes<HTMLDivElement> => (disabled || !enabled ? {} : {
        draggable: true,
        onDragStart: (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData(SCREEN_DRAG_TYPE, screenId);
            setDragId(screenId);
        },
        onDragOver: (e) => {
            if (!isScreenDrag(e) || !dragId || dragId === screenId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const after = sideOf(e);
            setHint((prev) => (prev && prev.screenId === screenId && prev.after === after ? prev : { screenId, after }));
        },
        onDrop: (e) => {
            if (!isScreenDrag(e)) return;
            e.preventDefault();
            drop(screenId, sideOf(e));
        },
        onDragEnd: end,
    });

    return { tabDragProps, hint, dragging: dragId };
}
