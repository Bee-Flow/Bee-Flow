// The inline "Ask AI" at the selection: closed, the question being typed, the
// assistant working, the one-line result. It asks through the SAME
// useSheetAssistant as the side panel, so the conversation shows up there too.
//
// The selection is captured when the box opens: moving the cursor afterwards
// changes neither what is asked nor where the box sits.

import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { selectionLabel } from './sheetAskText';
import { selectionFor, type Range, type SelectionKind } from './sheetModel';
import type { AssistantTier } from './useAssistantTier';
import type { GridState } from './useGridState';
import type { SheetAssistant } from './useSheetAssistant';

export const RESULT_MS = 8000;

export type AskPhase = 'closed' | 'input' | 'working' | 'result';
export interface AskSnapshot { range: Range; kind: SelectionKind; selection: string; label: string }
export interface AskResult { id: number; reply: string; changed: boolean; undone: boolean }

export interface SheetAsk {
    phase: AskPhase;
    text: string;
    setText: (text: string) => void;
    error: string | null;
    snapshot: AskSnapshot | null;
    result: AskResult | null;
    /** Counts up each time the box is opened, so an open box can take focus again. */
    openCount: number;
    open: () => void;
    close: (refocus?: boolean) => void;
    submit: () => void;
    stop: () => void;
    undo: () => void;
    openPanel: () => void;
}

export interface SheetAskOptions {
    assistant: SheetAssistant;
    grid: GridState;
    usedRows: number;
    tier: AssistantTier | null;
    focusGrid: () => void;
    onOpenPanel: () => void;
}

export default function useSheetAsk({ assistant, grid, usedRows, tier, focusGrid, onOpenPanel }: SheetAskOptions): SheetAsk {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<AskPhase>('closed');
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<AskSnapshot | null>(null);
    const [result, setResult] = useState<Omit<AskResult, 'undone'> | null>(null);
    const [openCount, setOpenCount] = useState(0);
    const latest = useRef({ grid, usedRows, focusGrid, tier, phase, text, snapshot });
    useEffect(() => { latest.current = { grid, usedRows, focusGrid, tier, phase, text, snapshot }; });

    const open = useCallback(() => {
        const { grid: g, usedRows: used, phase: p } = latest.current;
        if (p === 'working') return;
        const range = g.range;
        setSnapshot({ range, kind: g.kind, selection: selectionFor(range, g.kind, used, g.columns), label: selectionLabel(t, range, g.kind) });
        setPhase('input');
        setResult(null);
        setError(null);
        setOpenCount((n) => n + 1);
    }, [t]);

    const close = useCallback((refocus = true) => {
        setPhase('closed');
        setText('');
        setError(null);
        setResult(null);
        if (refocus) latest.current.focusGrid();
    }, []);

    const submit = useCallback(() => {
        const { snapshot: snap, text: question, tier: depth } = latest.current;
        if (!snap || !question.trim() || latest.current.phase !== 'input') return;
        setError(null);
        setPhase('working');
        assistant.send(question, snap.selection, depth?.value ?? 'auto', snap.kind).then((msg) => {
            if (!msg || msg.error) {
                setPhase('input');
                setError(msg ? msg.content : t('spreadsheet.ask.busy', 'The assistant is still answering another question.'));
                return;
            }
            setResult({ id: msg.id, reply: msg.content, changed: !!msg.changes });
            setPhase('result');
            setText('');
        }).catch(() => undefined);
    }, [assistant, t]);

    // The result goes away by itself.
    useEffect(() => {
        if (phase !== 'result') return undefined;
        const timer = setTimeout(() => close(false), RESULT_MS);
        return () => clearTimeout(timer);
    }, [phase, result?.id, close]);

    const undone = result ? !!assistant.messages.find((m) => m.id === result.id)?.undone : false;
    return {
        phase, text, setText, error, snapshot, openCount,
        result: result ? { ...result, undone } : null,
        open, close, submit,
        stop: assistant.stop,
        undo: () => { if (result) assistant.undo(result.id); },
        openPanel: () => { onOpenPanel(); close(false); },
    };
}
