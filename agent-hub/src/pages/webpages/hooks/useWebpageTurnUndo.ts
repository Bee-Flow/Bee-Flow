import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ChatMessage } from '../../../hooks/useChatEngine/types';
import { latestAssistantId } from '../webpageChatMessages';
import { isPrimaryFile, type PrimaryFile, type PrimarySetters } from '../webpageEditorTypes';

type Resolution = 'kept' | 'undone';

/**
 * Per-turn undo (plan W2).
 *
 * The bytes that were on screen before an assistant turn edited a file, kept
 * in a REF keyed by assistant-message id — deliberately not in the message
 * itself. Chat messages are PUT back to the server on every settled turn, and
 * a full copy of index.html per turn would grow that row without bound. The
 * cost of the ref is honest and visible: after a reload there is no
 * before-state, so the Undo chip is not offered at all (WebpageTurnCard
 * renders it only when `canUndo`).
 */
export function useWebpageTurnUndo(setters: PrimarySetters, markPrimaryDirty: (file: PrimaryFile) => void) {
    const undoSnapshotsRef = useRef(new Map<string, Map<string, string>>());
    // Which assistant message an incoming edit belongs to. Kept in a ref so
    // the SSE callback (created once) always sees the current turn.
    const latestAssistantIdRef = useRef<string | null>(null);
    // Turns the user has resolved: kept (chips dismissed) or undone.
    const [turnResolution, setTurnResolution] = useState<Record<string, Resolution>>({});

    // Remember the FIRST before-state per file per turn: a turn that rewrites
    // index.html three times must undo to what was on screen when the turn
    // started, not to its own second draft.
    const recordBefore = useCallback((file: string, before: string) => {
        const turnId = latestAssistantIdRef.current;
        if (!turnId) return;
        const map = undoSnapshotsRef.current;
        const entry = map.get(turnId) || new Map<string, string>();
        if (!entry.has(file)) entry.set(file, before);
        map.set(turnId, entry);
    }, []);

    const turnState = useCallback((msgId: string) => ({
        // Offer Undo only while the bytes to restore are really held.
        canUndo: !!msgId && undoSnapshotsRef.current.has(msgId),
        undone: turnResolution[msgId] === 'undone',
        kept: turnResolution[msgId] === 'kept',
    }), [turnResolution]);

    const handleKeepTurn = useCallback((msgId: string) => {
        if (!msgId) return;
        // Keeping is a dismissal, not a save: the edit was already persisted
        // by the normal save discipline the moment it landed.
        undoSnapshotsRef.current.delete(msgId);
        setTurnResolution(prev => ({ ...prev, [msgId]: 'kept' }));
    }, []);

    const handleUndoTurn = useCallback((msgId: string) => {
        const entry = msgId && undoSnapshotsRef.current.get(msgId);
        if (!entry) return;
        for (const [file, before] of entry.entries()) {
            if (!isPrimaryFile(file)) continue;
            setters[file](before ?? '');
            // Same path a human edit takes, so the restore is saved by the
            // ordinary debounce instead of living only on screen.
            markPrimaryDirty(file);
        }
        undoSnapshotsRef.current.delete(msgId);
        setTurnResolution(prev => ({ ...prev, [msgId]: 'undone' }));
    }, [markPrimaryDirty, setters]);

    return { latestAssistantIdRef, recordBefore, turnState, handleKeepTurn, handleUndoTurn };
}

/** Keep `ref` pointing at the latest assistant message of the chat. */
export function useLatestAssistantRef(chatMessages: ChatMessage[], ref: RefObject<string | null>) {
    useEffect(() => {
        ref.current = latestAssistantId(chatMessages);
    }, [chatMessages, ref]);
}
