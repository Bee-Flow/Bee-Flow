/**
 * Drag & drop on the canvas, and the AI turn's single history entry — both
 * use the same trick: restore a pre-change snapshot via plain set_definition,
 * then let an effect commit the real result AFTER that render, when
 * useDraftHistory sees the snapshot as current, so exactly one history entry
 * captures the whole gesture/turn.
 *
 * onDragOver applies CROSS-PARENT moves transiently (plain set_definition, no
 * history); the pre-drag snapshot is restored on drop/cancel and the final
 * result lands as ONE history commit, so Cmd+Z undoes a whole drag.
 */
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useCallback, useEffect, useRef } from 'react';
import type { ComponentType, CSSProperties, Dispatch, RefObject, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition } from '../../inspector/appDefinition';
import { APP_COMPONENT_TYPES } from '../../runtime/componentRegistry';
import type { AppEditorAction } from '../../state/appEditorState';
import { findNode, moveNode } from '../../state/definitionOps';
import { computeDragEnd, resolveDrop, screenIdFromScreenTabDroppable } from '../dnd';
import { computeDropHint } from '../dropHint';
import type { DropHint } from '../dropHint';

/** The DragOverlay chip: always a compact icon + label, never the live component. */
export interface ActiveDrag {
    label: string;
    Icon: ComponentType<{ className?: string; style?: CSSProperties; 'aria-hidden'?: boolean | 'true' }> | null;
}

interface PendingCommit {
    def: AppDefinition;
    select?: string | null;
    pulse?: string | null;
    screen?: string | null;
}

interface CanvasDragInputs {
    t: TranslateFn;
    dispatch: Dispatch<AppEditorAction>;
    definitionRef: RefObject<AppDefinition | null>;
    screenIdRef: RefObject<string | null>;
    commitDefinition: (def: AppDefinition) => void;
    streamLock: boolean;
    setActiveDrag: Dispatch<SetStateAction<ActiveDrag | null>>;
    setDropHint: Dispatch<SetStateAction<DropHint | null>>;
}

type DragData = { type?: string; componentType?: string; node?: { type?: string } };
const dragData = (event: { active?: { data?: { current?: unknown } } | null }): DragData => (event.active?.data?.current || {}) as DragData;

export function useCanvasDrag({ t, dispatch, definitionRef, screenIdRef, commitDefinition, streamLock, setActiveDrag, setDropHint }: CanvasDragInputs) {
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const dragSnapshotRef = useRef<AppDefinition | null>(null);
    // Deferred one-entry history commit, shared by drag&drop and the AI turn.
    const pendingCommitRef = useRef<PendingCommit | null>(null);
    // The transient preview's last resolved target, so an unchanged target does
    // not re-dispatch a fresh definition on every one of dragOver's many events.
    const previewTargetRef = useRef<string | null>(null);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        dragSnapshotRef.current = definitionRef.current;
        previewTargetRef.current = null;
        const data = dragData(event);
        const type = data.type === 'palette' ? data.componentType : data.node?.type;
        const entry = (APP_COMPONENT_TYPES as Record<string, { label?: string; icon?: ActiveDrag['Icon'] } | undefined>)[type as string];
        setActiveDrag({
            label: entry?.label || type || t('app_studio.shell.component', 'Component'),
            Icon: entry?.icon || null,
        });
    }, [t, definitionRef, setActiveDrag]);

    // Transient CROSS-PARENT preview: the node really moves in the draft so
    // the target section/container makes room — but via plain set_definition,
    // never a commit. Same-parent reorders preview only via the DragOverlay
    // (applying them live makes items oscillate under the pointer).
    // Both the indicator and the transient preview resolve against the PRE-DRAG
    // SNAPSHOT — the same definition finishDrag/resolveDrop commits against.
    // Reading the live draft instead made them disagree with the drop as soon as
    // a transient reparent had landed: with the node already previewed into the
    // target section, the hint saw it as a SAME-PARENT reorder and drew the line
    // after the hovered sibling, while the drop — resolved against the snapshot,
    // where the node is still in its old parent — put it before. One base for
    // all three, and the line cannot promise a slot the drop will not use.
    const handleDragOver = useCallback((event: DragOverEvent) => {
        const base = dragSnapshotRef.current;
        if (!base) return;
        const isPalette = dragData(event).type === 'palette';
        // The indicator is computed for EVERY drag, including palette ones —
        // "where will this land?" is the question a palette drag asks loudest.
        setDropHint(computeDropHint({ active: event.active, over: event.over, definition: base, isPalette }));
        if (!event.over) return;
        if (isPalette) return; // palette inserts happen on drop
        // A cross-screen drop is resolved on drop only — never transiently
        // reparent onto a screen the user can't see (the node would vanish
        // mid-drag). The single commit still lands in finishDrag/resolveDrop.
        if (screenIdFromScreenTabDroppable(event.over.id)) return;
        const res = computeDragEnd({ active: event.active, over: event.over, definition: base, screenId: screenIdRef.current });
        if (!res || res.op !== 'move') return;
        const found = findNode(base, res.nodeId);
        if (!found) return;
        if (found.parent.id === res.toParentId) {
            // Back over the node's OWN parent. Same-parent reorders are
            // deliberately not previewed — applying them live makes the items
            // oscillate under the pointer — but simply returning left any
            // earlier cross-parent preview applied, so the node sat in the
            // section the pointer had passed through while the indicator
            // pointed at the one it was over. Revert to the snapshot instead.
            if (previewTargetRef.current !== null) {
                previewTargetRef.current = null;
                if (definitionRef.current !== base) dispatch({ type: 'set_definition', definition: base });
            }
            return;
        }
        // dragOver fires continuously; re-deriving the same move would hand the
        // reducer a fresh definition object per event. Only an actually
        // different target is worth a render.
        const target = `${res.toParentId}#${res.index ?? 'end'}`;
        if (previewTargetRef.current === target) return;
        previewTargetRef.current = target;
        const next = moveNode(base, res.nodeId, { toParentId: res.toParentId, index: res.index ?? undefined });
        if (next !== definitionRef.current) dispatch({ type: 'set_definition', definition: next });
    }, [dispatch, definitionRef, screenIdRef, setDropHint]);

    const finishDrag = useCallback((event: DragEndEvent, cancelled: boolean) => {
        const snapshot = dragSnapshotRef.current;
        // The live draft carries any transient dragOver reparent; capture it
        // BEFORE we restore the snapshot below so resolveDrop can fall back to
        // it when the drop lands on the node itself (see dnd.resolveDrop).
        const liveDefinition = definitionRef.current;
        dragSnapshotRef.current = null;
        setActiveDrag(null);
        setDropHint(null);
        if (!snapshot) return;
        // Restore the pre-drag definition first: transient dragOver moves
        // must never enter history. The effect below runs after this render,
        // when useDraftHistory sees `snapshot` as current, and commits the
        // real result computed against the SNAPSHOT — one history entry.
        dispatch({ type: 'set_definition', definition: snapshot });
        if (cancelled || !event.over) return;
        const resolved = resolveDrop({ snapshot, liveDefinition, active: event.active, over: event.over, screenId: screenIdRef.current });
        if (!resolved) return;
        // A drop on a screen tab moves the node onto another screen — follow it
        // there so the user sees where it landed.
        const toScreen = screenIdFromScreenTabDroppable(event.over.id);
        pendingCommitRef.current = {
            def: resolved.def,
            select: resolved.nodeId,
            pulse: resolved.op === 'insert' ? resolved.nodeId : null,
            screen: toScreen || undefined,
        };
    }, [dispatch, definitionRef, screenIdRef, setActiveDrag, setDropHint]);

    useEffect(() => {
        const pending = pendingCommitRef.current;
        if (!pending) return;
        pendingCommitRef.current = null;
        commitDefinition(pending.def);
        if (pending.select) dispatch({ type: 'select_node', nodeId: pending.select });
        if (pending.pulse) dispatch({ type: 'set_recent_ids', ids: [pending.pulse] });
        // An AI turn may have moved the user to a screen that only exists in
        // the final draft; re-assert it after the snapshot round-trip.
        if (pending.screen) dispatch({ type: 'set_screen', screenId: pending.screen });
    });

    // ---- AI builder turn (chat pane) ----------------------------------------
    // The pre-turn snapshot is captured when streamLock flips on (the pane
    // locks BEFORE the first transient draft lands), so commitTurn can record
    // the whole AI turn as ONE undoable history entry.
    const turnBaseRef = useRef<AppDefinition | null>(null);
    useEffect(() => {
        if (streamLock) turnBaseRef.current = definitionRef.current;
    }, [streamLock, definitionRef]);

    const commitTurn = useCallback((finalDef: AppDefinition | null | undefined) => {
        if (!finalDef) return;
        const base = turnBaseRef.current;
        turnBaseRef.current = null;
        if (base && base !== finalDef) {
            // Same trick as finishDrag: restore the pre-turn snapshot first
            // (plain set_definition — transient drafts never enter history),
            // then the pending-commit effect above lands the final draft as
            // one history entry against that snapshot.
            dispatch({ type: 'set_definition', definition: base });
            pendingCommitRef.current = { def: finalDef, screen: screenIdRef.current };
        } else {
            commitDefinition(finalDef);
        }
    }, [dispatch, commitDefinition, definitionRef, screenIdRef]);

    return { sensors, handleDragStart, handleDragOver, finishDrag, commitTurn };
}
