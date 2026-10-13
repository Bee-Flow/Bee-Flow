import { useEffect } from 'react';
import type { StepId } from './diagramPaneTypes';

type StepAction = (stepId: StepId) => void;

export interface CanvasHotkeyOptions {
    selectedIds: StepId[];
    onAskAssistant: ((stepId: StepId) => void) | null;
    editable: boolean;
    structuralEditsBlocked: boolean;
    readOnly: boolean;
    /** The node runtime context: which ids are triggers and which are wired. */
    runtimeContextValue: { triggerIds?: Set<StepId>; attachedIds?: Set<StepId> };
    onExecuteStep: ((stepId: StepId, opts?: { mode: string }) => void) | null | undefined;
    runInFlight: boolean;
    onDuplicateNode: StepAction;
    onDetachNode: StepAction;
    onPinNode: StepAction;
    togglePresenter: () => void;
}

/**
 * The canvas's document-level keys, registered in this order:
 *   - Ctrl/Cmd+J on one selected step asks the assistant about it;
 *   - R / D / U / P on one selected step (the action chrome's equivalents);
 *   - Shift+P (or P with nothing selected) toggles presenter mode.
 */
export function useCanvasHotkeys({
    selectedIds, onAskAssistant, editable, structuralEditsBlocked, readOnly, runtimeContextValue,
    onExecuteStep, runInFlight, onDuplicateNode, onDetachNode, onPinNode, togglePresenter,
}: CanvasHotkeyOptions): void {
    useEffect(() => {
        if (!onAskAssistant || selectedIds.length !== 1) return undefined;
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onAskAssistant(selectedIds[0]);
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onAskAssistant, selectedIds]);

    // ── Keyboard equivalents of the action chrome ────────────────────────
    //
    // R (run up to here) · D (duplicate) · U (disconnect) · P (pin). One
    // document listener for the whole canvas, not one per card, gated on
    // exactly one selected node. Bare letters must never fire while the user
    // is typing — the assistant composer, a note's inline text, the search
    // box — so anything editable swallows them; modifier combos are left to
    // useBuilderHotkeys.
    useEffect(() => {
        if (!editable || structuralEditsBlocked || selectedIds.length !== 1) return undefined;
        const id = selectedIds[0];
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Shift+P is presenter mode (the listener below); never a pin.
            if (e.shiftKey) return;
            const el = e.target as HTMLElement | null;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            const key = String(e.key || '').toLowerCase();
            const isTrigger = runtimeContextValue.triggerIds?.has?.(id);
            if (key === 'r' && onExecuteStep && !runInFlight) { e.preventDefault(); onExecuteStep(id, { mode: 'upTo' }); }
            else if (key === 'd' && !isTrigger) { e.preventDefault(); onDuplicateNode(id); }
            else if (key === 'u' && !isTrigger && runtimeContextValue.attachedIds?.has?.(id)) { e.preventDefault(); onDetachNode(id); }
            else if (key === 'p' && !isTrigger) { e.preventDefault(); onPinNode(id); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [editable, structuralEditsBlocked, selectedIds, runtimeContextValue, onExecuteStep, runInFlight, onDuplicateNode, onDetachNode, onPinNode]);

    // Presenter mode from the keyboard: Shift+P anywhere on the canvas, and
    // plain P only while nothing is selected — on a selected card P is "freeze
    // the output" (above). Same editable-field guard as the letters above.
    useEffect(() => {
        if (readOnly) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (String(e.key || '').toLowerCase() !== 'p') return;
            const el = e.target as HTMLElement | null;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
            if (!e.shiftKey && selectedIds.length !== 0) return;
            e.preventDefault();
            togglePresenter();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [readOnly, selectedIds, togglePresenter]);
}
