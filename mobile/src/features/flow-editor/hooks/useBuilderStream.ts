/**
 * "Ask AI" for an open routine: the AI builder's streamed turn, wired into the
 * routine's draft store.
 *
 *   - Before a turn the draft is saved: the builder loads the STORED routine,
 *     builds on it, and its drafts then replace the one on screen — so an
 *     unsaved edit would first be ignored and then overwritten. A save that
 *     fails refuses the turn (UnsavedDraftError).
 *   - While the turn streams the draft store is locked (no local edits), and
 *     every `draft` frame replaces the definition — already persisted by the
 *     server — as ONE undo entry for the whole turn.
 *   - `validation_errors` become the store's builder findings.
 *   - A turn on a routine that does not exist yet creates it server-side; the
 *     store adopts the id from `builder_session`.
 *
 * The transcript starts from the persisted session and grows by each turn.
 * The live turn is a store (`turn`): subscribe with useTurn from
 * @/shared/stream.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { useTurnStream, type TurnSource } from '@/shared/stream';

import { refreshRoutineViews } from './cacheSync';
import { useBuilderSession } from './queries';
import type { FlowDraft } from './useFlowDraft';
import { BUILDER_STREAM_PATH, builderTurnBody, type BuilderMessage } from '../api/builder';
import { builderFrames, emptyBuilderTurn, type BuilderFrameCallbacks, type BuilderTurn } from '../api/builderStream';
import { flowKeys } from '../api/keys';
import { UnsavedDraftError } from '../state/ensureSaved';

export interface BuilderStreamOptions {
    /** A model tier name; the server's 'auto' when omitted. */
    modelTier?: string;
    /** The flowlet on screen, as a hint for the model. */
    canvasScope?: string | null;
}

export interface BuilderStream {
    turn: TurnSource<BuilderTurn>;
    streaming: boolean;
    /** Earlier turns, oldest first; the live one is `turn`. */
    transcript: BuilderMessage[];
    send: (message: string) => Promise<void>;
    stop: () => void;
}

/**
 * The frames about the routine, applied to its draft store. A turn that
 * created the routine hands its id over here; useFlowDraft then announces it
 * (FlowDraftOptions.onCreated), exactly as for a routine created by a save.
 */
function useFrameCallbacks(draft: FlowDraft, sessionId: { current: string | null }) {
    const queryClient = useQueryClient();
    const latest = useRef<BuilderFrameCallbacks>({});
    useEffect(() => {
        const state = () => draft.store.getState();
        latest.current = {
            onSession: ({ automationId, builderSessionId }) => {
                sessionId.current = builderSessionId ?? sessionId.current;
                if (automationId) state().adoptAutomationId(automationId);
            },
            onDraft: (definition) => state().replaceDefinition(definition, { persisted: true }),
            onValidation: (validation) => state().setIssues('builder', validation),
            onMetadata: () => refreshRoutineViews(queryClient, state().automationId),
        };
    });
    return latest;
}

/**
 * The conversation: the persisted session until this screen sends its first
 * turn, and from then on that session as it was, plus this screen's turns —
 * so a later read of the session (which includes those turns) cannot double
 * them.
 */
interface Transcript {
    base: BuilderMessage[] | null;
    turns: BuilderMessage[];
}

export function useBuilderStream(draft: FlowDraft, options: BuilderStreamOptions = {}): BuilderStream {
    const queryClient = useQueryClient();
    const sessionId = useRef<string | null>(null);
    const inFlight = useRef(false);
    const [local, setLocal] = useState<Transcript>({ base: null, turns: [] });
    const callbacks = useFrameCallbacks(draft, sessionId);
    const [adapter] = useState(() => builderFrames(() => callbacks.current));
    const automationId = useStore(draft.store, (s) => s.automationId);
    const session = useBuilderSession(automationId);
    const stored = session.data?.conversation ?? [];
    const transcript = local.base ? [...local.base, ...local.turns] : stored;

    const stream = useTurnStream<BuilderTurn>({
        empty: emptyBuilderTurn,
        adapter,
        onDone: (turn) => {
            const store = draft.store.getState();
            store.setLocked(false);
            if (turn.text || turn.toolCalls.length) {
                const reply: BuilderMessage = { role: 'assistant', content: turn.text, toolCalls: turn.toolCalls };
                setLocal((current) => ({ ...current, turns: [...current.turns, reply] }));
            }
            const id = store.automationId;
            if (id) void queryClient.invalidateQueries({ queryKey: flowKeys.definition(id) });
        },
    });

    const runTurn = async (message: string) => {
        const store = draft.store.getState();
        if (!(await store.flush())) throw new UnsavedDraftError(draft.store.getState().saveError);
        const history = transcript.map(({ role, content }) => ({ role, content }));
        const asked: BuilderMessage = { role: 'user', content: message, toolCalls: [] };
        setLocal((current) => ({ base: current.base ?? stored, turns: [...current.turns, asked] }));
        store.setLocked(true);
        store.setIssues('builder', null);
        const body = builderTurnBody({
            message,
            automationId: draft.store.getState().automationId,
            builderSessionId: sessionId.current ?? session.data?.sessionId ?? null,
            history,
            modelTier: options.modelTier,
            canvasScope: options.canvasScope,
        });
        await stream.run(BUILDER_STREAM_PATH, body);
    };

    /** One turn at a time: a second send while one streams is ignored (stop it first). */
    const send = async (message: string) => {
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            await runTurn(message);
        } finally {
            inFlight.current = false;
        }
    };

    return { turn: stream.store, streaming: stream.streaming, transcript, send, stop: stream.stop };
}
