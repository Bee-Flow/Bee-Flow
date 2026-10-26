import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import type { Dispatch, RefObject } from 'react';
import { boundTableIdFor, canAutoSendApp } from './builderPaneModel';
import type { EditorChrome } from './builderPaneModel';
import type { AppBuilderSendOptions } from '@/hooks/useAppBuilderStream';
import type { AppDefinition } from '../inspector/appDefinition';
import type { AppEditorAction } from '../state/appEditorState';

type Send = (textOrOpts: string | AppBuilderSendOptions, maybeOpts?: AppBuilderSendOptions) => unknown;

interface TurnControlInputs {
    busy: boolean;
    send: Send;
    tierForSend: string;
    autoSend: string | null;
    messageCount: number;
    pendingPlan: { planId?: unknown } | null;
    dispatch: Dispatch<AppEditorAction>;
    setStarting: (starting: boolean) => void;
    beginTurn: () => void;
    definitionRef: RefObject<AppDefinition | null>;
    screenIdRef: RefObject<string | null>;
    chromeRef: RefObject<EditorChrome | null>;
    selectedNodeId: string | null;
    selectedNodeIds: Set<string>;
}

/**
 * Starting AI turns: a typed message, a quick action, a per-issue Fix, a
 * plan approval, "Try again" and a host's auto-sent brief all go through the
 * SAME streamLock/flush/commitTurn flow.
 */
export function useTurnControls({
    busy, send, tierForSend, autoSend, messageCount, pendingPlan, dispatch, setStarting, beginTurn,
    definitionRef, screenIdRef, chromeRef, selectedNodeId, selectedNodeIds,
}: TurnControlInputs) {
    const lastTurnRef = useRef<{ text: string; extraContext: unknown; sendOptions: AppBuilderSendOptions | undefined } | null>(null);    // for retry-after-error

    // Refs so startTurn reads the LIVE selection without re-binding every chip.
    const selectionRef = useRef({ selectedNodeId, selectedNodeIds });
    useEffect(() => { selectionRef.current = { selectedNodeId, selectedNodeIds }; });

    // The editor's current focus (selection / screen / bound table), merged
    // with any `extraContext` override (e.g. a per-issue Fix targeting a node).
    const buildContext = useCallback((extraContext?: unknown) => {
        const def = definitionRef.current;
        const { selectedNodeId: anchor, selectedNodeIds: ids } = selectionRef.current;
        const idList = ids instanceof Set ? [...ids] : [];
        return {
            screenId: screenIdRef.current,
            selectedNodeIds: idList,
            boundTableId: boundTableIdFor(def, anchor || idList[idList.length - 1] || null),
            ...(extraContext && typeof extraContext === 'object' ? extraContext : {}),
        };
    }, [definitionRef, screenIdRef]);

    // Persist any pending local edit BEFORE the AI reads the app, then lock and
    // fire `run`. The builder reads the definition from the DB, and locking
    // pauses autosave, so an unsaved edit would be invisible to the AI and then
    // overwritten by the turn's markSaved. The lock therefore lands only AFTER
    // flush() resolves — locking first would strand the in-flight edit; until
    // then `starting` stands in for it so no second turn can begin.
    const lockAndRun = useCallback((run: () => void) => {
        beginTurn();
        setStarting(true);
        const go = () => {
            dispatch({ type: 'set_stream_lock', streamLock: true });
            setStarting(false);
            run();
        };
        Promise.resolve(chromeRef.current?.flush?.()).then(go, go);
    }, [dispatch, beginTurn, setStarting, chromeRef]);

    /**
     * Start one AI turn with `text`, threading editor focus as context.
     * `sendOptions` passes stream options through (e.g. quick actions force
     * `planMode:'never'`). Goes through the SAME streamLock/flush/commitTurn
     * flow as a typed message.
     */
    const startTurn = useCallback((text: unknown, extraContext?: unknown, sendOptions?: AppBuilderSendOptions) => {
        const message = typeof text === 'string' ? text.trim() : '';
        // An attached picture is a complete ask on its own ("build this"), so a
        // turn needs text OR images.
        const attached = Array.isArray(sendOptions?.images) ? sendOptions.images.filter(Boolean) : [];
        if ((!message && !attached.length) || busy) return;
        // Remember the turn so a retryable error (Wave 6c) can re-run it verbatim.
        lastTurnRef.current = { text: message, extraContext, sendOptions };
        const context = buildContext(extraContext);
        lockAndRun(() => send(message, { modelTier: tierForSend, context, ...(sendOptions || {}) }));
    }, [busy, send, buildContext, lockAndRun, tierForSend]);

    // A host's brief, sent once at mount (canAutoSendApp): the pane is fresh
    // (no messages, nothing in flight), so this is the first turn of a phase.
    // The ref survives re-renders and StrictMode's double effect; a new phase
    // is a new mount (the host's `key`). Rehydrated history that lands later
    // does not undo a send already made.
    const autoSentRef = useRef(false);
    const sendBrief = useEffectEvent(() => startTurn(autoSend, undefined, { planMode: 'never' }));
    useEffect(() => {
        if (autoSentRef.current) return;
        if (!canAutoSendApp({ autoSend, messageCount, busy })) return;
        autoSentRef.current = true;
        sendBrief();
    }, [autoSend, busy, messageCount]);

    // "Try again" on a retryable error item: re-run the last turn verbatim.
    const retryLastTurn = useCallback(() => {
        const lt = lastTurnRef.current;
        if (!lt || busy) return;
        startTurn(lt.text, lt.extraContext, lt.sendOptions);
    }, [busy, startTurn]);

    /**
     * Approve the (possibly edited) plan from the PlanCard — the AI builds the
     * artifact the user confirmed. Same lock/flush/commit flow as a turn.
     */
    const approvePlan = useCallback((editedPlan: unknown) => {
        if (busy || !pendingPlan) return;
        const context = buildContext();
        lockAndRun(() => send({
            plan: { planId: pendingPlan.planId, action: 'approve', plan: editedPlan },
            modelTier: tierForSend,
            context,
        }));
    }, [busy, pendingPlan, send, buildContext, lockAndRun, tierForSend]);

    return { startTurn, retryLastTurn, approvePlan };
}
