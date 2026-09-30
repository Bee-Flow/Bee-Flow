/**
 * What the canvas's gestures and buttons DO to the routine, and the canvas's
 * own modes. Every edit is one pure operation through the draft store's
 * `applyOp`, so each is one undo step and is saved by the autosave; opening
 * a step, a card's menu and the step picker are the build screen's own
 * (the same ones the Steps outline uses).
 *
 *   edit mode     tap opens, hold opens the menu, hold-and-drag moves, "+"
 *                 adds (on a line: into it), a loop opens in place
 *   connect mode  tap a port (or a step with one way out), then the step the
 *                 line goes to — the web's drag from a handle to a handle,
 *                 by two taps; a line's "×" removes it
 */

import { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import type { Catalog } from '@/features/flow-editor/bindings';
import type { ArrangeMode, FlowDefinition } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import type { DraftStore } from '@/features/flow-editor/state';
import { useToast } from '@/shared/ui';

import type { NodeState } from './CanvasNode';
import type { CanvasActions } from './CanvasRuntime';
import { connectNodes, connectRefusal, removeConnection, type ConnectRefusal } from './connect';
import { toggleExpanded } from './inlineLoops';
import { arrangeFlow, moveNode } from './moves';
import type { CanvasMode } from './overlay';
import type { PortSpec } from './ports';
import type { Scene } from './scene';
import type { Size } from './viewport';

const REFUSALS: Record<ConnectRefusal, [string, string]> = {
    self: ['mobile.flow.canvas.refused.self', 'A step cannot connect to itself'],
    no_input: ['mobile.flow.canvas.refused.no_input', 'Nothing flows into a trigger or a note'],
    no_output: ['mobile.flow.canvas.refused.no_output', 'Nothing leaves a note'],
    nested: ['mobile.flow.canvas.refused.nested', 'Steps inside a loop run top to bottom — use the + on its line to add one'],
    unlabelled: ['mobile.flow.canvas.refused.unlabelled', 'Tap one of its dots: each is a different branch'],
    terminal: ['mobile.flow.canvas.refused.terminal', 'Nothing runs after this step'],
    duplicate: ['mobile.flow.canvas.refused.duplicate', 'These two are already connected that way'],
    cycle: ['mobile.flow.canvas.refused.cycle', 'That line would make the flow run in a circle'],
};

export function refusalWords(refusal: ConnectRefusal, t: TranslateFn): string {
    const [key, fallback] = REFUSALS[refusal];
    return t(key, fallback);
}

export interface PendingLine {
    key: string;
    port: PortSpec;
}

interface Options {
    store: DraftStore;
    definition: FlowDefinition;
    scene: Scene;
    catalog: Catalog | null;
    locked: boolean;
    onOpenStep: (address: string) => void;
    onMenu?: (address: string) => void;
    onAdd?: (target: AddTarget) => void;
    setExpanded: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
}

export function useCanvasEditing({ store, definition, scene, catalog, locked, onOpenStep, onMenu, onAdd, setExpanded }: Options) {
    const t = useTranslation();
    const { toast } = useToast();
    const [mode, setModeState] = useState<CanvasMode>('edit');
    const [pending, setPending] = useState<PendingLine | null>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const apply = (op: (def: FlowDefinition) => FlowDefinition) => store.getState().applyOp(op);
    /** An "Each item" pill stands for its loop. */
    const ownerOf = (key: string) => (scene.byKey.get(key)?.kind === 'entry' ? (scene.byKey.get(key)?.parent ?? key) : key);

    const connectTo = (target: string, from: PendingLine) => {
        const result = connectNodes(store.getState().definition ?? definition, { source: from.key, target, handle: from.port.wire }, { catalog });
        if (!result.ok) {
            toast(refusalWords(result.refusal, t), 'error');
            return;
        }
        apply(() => result.definition);
        setPending(null);
        const words = result.mapped || result.forEach
            ? t('mobile.flow.auto_mapped', 'Filled {n} inputs from the step before', { n: result.mapped })
            : t('mobile.flow.canvas.connected', 'Connected');
        toast(words, 'success');
    };

    const connectTap = (key: string) => {
        if (pending) {
            if (pending.key === key) setPending(null);
            else connectTo(key, pending);
            return;
        }
        const ports = scene.byKey.get(key)?.ports ?? [];
        if (ports.length === 1) setPending({ key, port: ports[0] as PortSpec });
        else toast(refusalWords(ports.length ? 'unlabelled' : 'no_output', t), 'error');
    };

    const actions: CanvasActions = {
        tap: (key) => (mode === 'connect' && !locked ? connectTap(key) : onOpenStep(ownerOf(key))),
        menu: (key) => onMenu?.(ownerOf(key)),
        moved: (key, dx, dy) => {
            apply((d) => moveNode(d, key, { dx, dy }));
        },
        dragging: setDragging,
        pickPort: (key, port) => setPending((prev) => (prev?.key === key && prev.port.id === port.id ? null : { key, port })),
        add: (target) => onAdd?.(target),
        removeEdge: (edge) => {
            if (apply((d) => removeConnection(d, edge))) toast(t('mobile.flow.canvas.removed_line', 'Connection removed — Undo brings it back'), 'success');
        },
        toggleLoop: (key) => setExpanded((prev) => toggleExpanded(prev, key)),
    };

    /** How a node is drawn right now: dragged, the line's start, or a place a line cannot go. */
    const stateOf = (key: string): NodeState => {
        if (dragging === key) return 'ghost';
        if (mode !== 'connect' || !pending) return 'idle';
        if (pending.key === key) return 'picked';
        return connectRefusal(definition, { source: pending.key, target: key, handle: pending.port.wire }) ? 'dim' : 'idle';
    };

    return {
        mode,
        pending,
        dragging,
        actions,
        stateOf,
        setMode: (next: CanvasMode) => {
            setModeState(next);
            setPending(null);
        },
        arrange: (arrangeMode: ArrangeMode, size: Size) => apply((d) => arrangeFlow(d, arrangeMode, size)) !== null,
    };
}

export type CanvasEditing = ReturnType<typeof useCanvasEditing>;
