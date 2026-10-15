import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BuilderMessage, BuilderTodo, BuilderTurn, BuilderValidation } from '../builderStream';
import { finalizeStreaming, openTurn } from '../builderStream';
import type { AppBuilderSendOptions } from './types';

/** The saved-session snapshot GET /builder/session/:appId hands back. */
interface RestoredSnapshot {
    messages?: unknown;
    sessionId?: string | null;
    lastValidation?: BuilderValidation | null;
    pendingPlan?: unknown;
    checkpoints?: unknown;
    todos?: unknown;
}

export interface RestoreSetters {
    sessionIdRef: MutableRefObject<string | null>;
    setMessages: Dispatch<SetStateAction<BuilderMessage[]>>;
    setSessionId: Dispatch<SetStateAction<string | null>>;
    setLastValidation: Dispatch<SetStateAction<BuilderValidation | null>>;
    setPendingPlan: Dispatch<SetStateAction<unknown>>;
    setCheckpoints: Dispatch<SetStateAction<unknown[]>>;
    setTodos: Dispatch<SetStateAction<BuilderTodo[]>>;
}

/** Rehydrate the transcript, plan, checkpoints and checklist from a saved snapshot. */
export function applyBuilderSnapshot(snap: RestoredSnapshot, s: RestoreSetters): void {
    if (Array.isArray(snap.messages)) {
        const restored: BuilderMessage[] = snap.messages.filter((m: unknown) => m && typeof m === 'object');
        // A turn may have started while this request was in flight —
        // restore the history IN FRONT of it, never over it.
        s.setMessages((live) => (live.length ? [...restored, ...live] : restored));
    }
    if (snap.sessionId) {
        s.sessionIdRef.current = snap.sessionId;
        s.setSessionId(snap.sessionId);
    }
    if (snap.lastValidation) s.setLastValidation(snap.lastValidation);
    // A build interrupted mid-approval left a plan on the snapshot
    // (top-level, trim-safe) — surface the card again so a refresh
    // doesn't lose the pending plan.
    if (snap.pendingPlan && typeof snap.pendingPlan === 'object') {
        s.setPendingPlan(snap.pendingPlan);
    }
    if (Array.isArray(snap.checkpoints)) {
        s.setCheckpoints(snap.checkpoints.filter((c: unknown) => c && typeof c === 'object'));
    }
    // The checklist the model was ticking survives a refresh.
    if (Array.isArray(snap.todos)) {
        s.setTodos(snap.todos
            .filter((t: BuilderTodo) => t && typeof t.text === 'string')
            .map((t: BuilderTodo) => ({ text: t.text, done: !!t.done })));
    }
}

/** The pieces of one `send(...)` call, normalised from `send(text, opts)` / `send(opts)`. */
export interface ParsedSend {
    options: AppBuilderSendOptions;
    message: string;
    isApproval: boolean;
    images: string[];
}

export function parseSendArgs(
    textOrOpts: string | AppBuilderSendOptions,
    maybeOpts?: AppBuilderSendOptions,
): ParsedSend {
    let options: AppBuilderSendOptions; let text: string | undefined;
    if (textOrOpts && typeof textOrOpts === 'object') {
        options = textOrOpts;
        text = typeof options.message === 'string' ? options.message : '';
    } else {
        text = textOrOpts;
        options = maybeOpts || {};
    }
    const message = typeof text === 'string' ? text.trim() : '';
    const isApproval = !!(options.plan && typeof options.plan === 'object');
    const images = Array.isArray(options.images) ? options.images.filter((u) => typeof u === 'string' && u) : [];
    return { options, message, isApproval, images };
}

export interface ActionStartSetters {
    lastToolCallRef: MutableRefObject<unknown>;
    phasesTotalRef: MutableRefObject<number>;
    setRunning: Dispatch<SetStateAction<boolean>>;
    setLastValidation: Dispatch<SetStateAction<BuilderValidation | null>>;
    setPendingPlan: Dispatch<SetStateAction<unknown>>;
    setPhases: Dispatch<SetStateAction<unknown[]>>;
    setCheckpoints: Dispatch<SetStateAction<unknown[]>>;
    setContinuation: Dispatch<SetStateAction<{ phase: unknown; total: number | null } | null>>;
    setTurn: Dispatch<SetStateAction<BuilderTurn | null>>;
    setToolDraft: Dispatch<SetStateAction<Record<string, unknown> | null>>;
    setMessages: Dispatch<SetStateAction<BuilderMessage[]>>;
}

/** A fresh user action: clean plan/phase/checkpoint slate, a new turn record, the user's bubble and a streaming assistant bubble. */
export function startBuilderAction(s: ActionStartSetters, p: ParsedSend): void {
    const { options, message, isApproval, images } = p;
    s.setRunning(true);
    s.setLastValidation(null);
    // A fresh user action starts a clean plan/phase/checkpoint slate. The
    // approval turn clears the pending card (the build is starting).
    s.setPendingPlan(null);
    s.setPhases([]);
    s.setCheckpoints([]);
    s.setContinuation(null);
    s.phasesTotalRef.current = 0;
    // A fresh turn record: the waiting card counts from here. (The
    // checklist is NOT cleared — the model keeps ticking the same list
    // across turns; app_set_plan replaces it when it restructures.)
    s.setTurn(openTurn(options.modelTier));
    s.setToolDraft(null);
    // The previous turn's last call must not order THIS turn's first reveal.
    s.lastToolCallRef.current = null;
    // Push the user's message (a textless approval still gets a "Build it"
    // bubble so the transcript reads), any pictures they attached, then a
    // fresh streaming assistant bubble.
    const userBubble = message || (isApproval ? 'Build it' : '');
    s.setMessages((msgs) => [
        // A previously aborted turn may have left isStreaming behind —
        // settle it so its thinking block stops pulsing.
        ...finalizeStreaming(msgs),
        ...(userBubble ? [{ role: 'user' as const, content: userBubble }] : []),
        ...images.map((dataUrl) => ({ kind: 'image', dataUrl, caption: 'You attached this', fromUser: true })),
        { role: 'assistant' as const, content: '', thinkingParts: [], isStreaming: true },
    ]);
}
