// The conversation with the spreadsheet assistant: what was asked, what came
// back, and what it did to the cells. Kept in memory only.
//
// Order of a question: the queued edits are sent first (so the server reads
// the latest cells), then the question. The answer's changes are ALREADY saved
// on the server, so they are laid over the local cells without a save; Undo
// writes the old values back through the normal edit path.

import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { askSheetAssistant, type AssistantChange, type AssistantTurn } from './sheetAssistantApi';
import type { SelectionKind } from './sheetModel';
import type { SheetChartsState } from './useSheetCharts';
import type { SheetState } from './useSheet';

export const FLASH_MS = 3000;
const HISTORY_TURNS = 6;

/** A selection with no kind given: one cell, or a block. */
function kindFromSelection(selection: string | null): SelectionKind | undefined {
    if (!selection) return undefined;
    return selection.includes(':') ? 'range' : 'cell';
}

export interface AssistantMessage {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    error?: boolean;
    changes?: Record<string, AssistantChange>;
    undone?: boolean;
    /** The tier asked for and the one the server says answered. */
    requestedTier?: string;
    tier?: string | null;
}

export interface SheetAssistant {
    messages: AssistantMessage[];
    busy: boolean;
    flashed: Set<string>;
    /** Ask. Resolves with the assistant's message (an error one when it failed), or null when nothing was sent. */
    send: (text: string, selection: string | null, modelTier: string, selectionKind?: SelectionKind) => Promise<AssistantMessage | null>;
    stop: () => void;
    undo: (id: number) => void;
}

export default function useSheetAssistant(docId: string, sheet: SheetState, charts?: SheetChartsState): SheetAssistant {
    const { t } = useTranslation();
    const [messages, setMessages] = useState<AssistantMessage[]>([]);
    const [busy, setBusy] = useState(false);
    const [flashed, setFlashed] = useState<Set<string>>(new Set());
    const log = useRef<AssistantMessage[]>([]);
    const nextId = useRef(1);
    const abort = useRef<AbortController | null>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sheetRef = useRef(sheet);
    useEffect(() => { sheetRef.current = sheet; });

    const push = useCallback((m: Omit<AssistantMessage, 'id'>) => {
        const msg = { ...m, id: nextId.current++ };
        log.current = [...log.current, msg];
        setMessages(log.current);
        return msg;
    }, []);

    const flash = useCallback((names: string[]) => {
        if (flashTimer.current) clearTimeout(flashTimer.current);
        setFlashed(new Set(names));
        flashTimer.current = setTimeout(() => { flashTimer.current = null; setFlashed(new Set()); }, FLASH_MS);
    }, []);

    useEffect(() => () => {
        if (flashTimer.current) clearTimeout(flashTimer.current);
        abort.current?.abort();
    }, []);

    const send = useCallback(async (text: string, selection: string | null, modelTier: string, selectionKind?: SelectionKind): Promise<AssistantMessage | null> => {
        const message = text.trim();
        if (!message || abort.current) return null;
        const history: AssistantTurn[] = log.current.filter((m) => !m.error).slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content }));
        push({ role: 'user', content: message });
        const ctrl = new AbortController();
        abort.current = ctrl;
        setBusy(true);
        let reply: AssistantMessage;
        try {
            await sheetRef.current.flush().catch(() => undefined);
            const tab = sheetRef.current.activeTab;
            const answer = await askSheetAssistant(docId, {
                message, selection, selectionKind: selectionKind ?? kindFromSelection(selection), history, modelTier,
                ...(tab ? { tab } : {}),
            }, ctrl.signal);
            const names = Object.keys(answer.changes).filter((k) => answer.changes[k].before !== answer.changes[k].after);
            const changes = Object.fromEntries(names.map((k) => [k, answer.changes[k]]));
            if (names.length) {
                sheetRef.current.applySaved(Object.fromEntries(names.map((k) => [k, changes[k].after])));
                flash(names);
            }
            if (answer.charts?.length) {
                charts?.applyCharts(answer.charts).catch(() => undefined);
            }
            reply = push({ role: 'assistant', content: answer.reply, changes: names.length ? changes : undefined, requestedTier: modelTier, tier: answer.tier });
        } catch (e) {
            if (ctrl.signal.aborted) {
                // The server may have finished and saved: show what it holds.
                reply = push({ role: 'assistant', error: true, content: t('spreadsheet.assistant.stopped', 'Stopped. The sheet was reloaded in case some changes were already saved.') });
                sheetRef.current.refresh().catch(() => undefined);
            } else {
                reply = push({ role: 'assistant', error: true, content: (e as Error).message || t('spreadsheet.assistant.failed', 'The assistant could not answer.') });
            }
        } finally {
            abort.current = null;
            setBusy(false);
        }
        return reply;
    }, [docId, flash, push, t]);

    const stop = useCallback(() => { abort.current?.abort(); }, []);

    const undo = useCallback((id: number) => {
        const msg = log.current.find((m) => m.id === id);
        if (!msg?.changes || msg.undone) return;
        sheetRef.current.setCells(Object.fromEntries(Object.entries(msg.changes).map(([k, c]) => [k, c.before])));
        log.current = log.current.map((m) => (m.id === id ? { ...m, undone: true } : m));
        setMessages(log.current);
    }, []);

    return { messages, busy, flashed, send, stop, undo };
}
