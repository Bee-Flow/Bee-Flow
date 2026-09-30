/**
 * What every node and button on the canvas reaches for, handed down once:
 * the actions (open, menu, move, connect, add, …) behind a STABLE object
 * whose calls always land on the latest handlers — so a memoised node never
 * re-renders because a handler was re-created — and the shared values a
 * drag writes on the UI thread.
 */

import React, { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import type { AddTarget } from '@/features/flow-editor/model/outline';

import type { PortSpec } from './ports';
import type { SceneEdge } from './sceneEdges';

export interface CanvasActions {
    /** Tap: open the step (or, in connect mode, pick it as the line's end). */
    tap: (key: string) => void;
    /** Hold without moving: the node's menu. */
    menu: (key: string) => void;
    /** A drag ended: the node moved by this much (world units). */
    moved: (key: string, dx: number, dy: number) => void;
    /** A drag began or ended (null): only that node's ghost follows the finger. */
    dragging: (key: string | null) => void;
    /** Connect mode: a line leaves from this port. */
    pickPort: (key: string, port: PortSpec) => void;
    add: (target: AddTarget) => void;
    removeEdge: (edge: SceneEdge) => void;
    toggleLoop: (key: string) => void;
}

/** The drag in flight: which node, and how far it has gone (world units). */
export interface DragState {
    key: string;
    dx: number;
    dy: number;
}

export interface CanvasRuntime {
    actions: CanvasActions;
    drag: SharedValue<DragState>;
    scale: SharedValue<number>;
    /** Nodes may be dragged (not while the AI builds, not in connect mode). */
    canDrag: boolean;
}

const RuntimeContext = createContext<CanvasRuntime | null>(null);

export function useCanvasRuntime(): CanvasRuntime {
    const value = useContext(RuntimeContext);
    if (!value) throw new Error('A canvas node must render inside <CanvasRuntimeProvider>');
    return value;
}

/**
 * An actions object whose identity never changes and whose calls reach
 * `latest` — the one rendered last (the ref is brought up to date after each
 * render, before any touch can reach a handler).
 */
export function useStableActions(latest: CanvasActions): CanvasActions {
    const ref = useRef(latest);
    useLayoutEffect(() => {
        ref.current = latest;
    });
    const [stable] = useState<CanvasActions>(() => ({
        tap: (key) => ref.current.tap(key),
        menu: (key) => ref.current.menu(key),
        moved: (key, dx, dy) => ref.current.moved(key, dx, dy),
        dragging: (key) => ref.current.dragging(key),
        pickPort: (key, port) => ref.current.pickPort(key, port),
        add: (target) => ref.current.add(target),
        removeEdge: (edge) => ref.current.removeEdge(edge),
        toggleLoop: (key) => ref.current.toggleLoop(key),
    }));
    return stable;
}

export function CanvasRuntimeProvider({ value, children }: { value: CanvasRuntime; children: ReactNode }) {
    return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
