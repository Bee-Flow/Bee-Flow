import { useMemo, useState } from 'react';
import { addedStepsOf, describeToolCall } from '../chat/toolCallDisplay';
import { chapterOf } from '../flow/buildChoreography';


export interface UseBuildCueOptions {
    state: any;
    flatDef: any;
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => string;
}

/**
 * The build cue: what the canvas needs to know about the assistant's turn.
 * Split out of BuildTab without a change in behaviour.
 */
export default function useBuildCue({ state, flatDef, t }: UseBuildCueOptions) {
    // ── The build cue ───────────────────────────────────────────────────────
    //
    // What the canvas needs to know about the assistant's turn — the banner,
    // the ghost slot and the camera all read this one object. It must change
    // once per tool call, not once per streamed token: the stream hook mutates
    // the in-flight assistant message IN PLACE, so the message's identity says
    // nothing, and the memos below key on the arrays and fields the hook does
    // replace (`toolCalls`, `thinkingSummary`) — never on the message object.
    const lastAssistant = (() => {
        for (let i = state.messages.length - 1; i >= 0; i--) {
            if (state.messages[i]?.role === 'assistant') return state.messages[i];
        }
        return null;
    })();
    const lastToolCalls = lastAssistant?.toolCalls;
    const lastThinkingSummary = lastAssistant?.thinkingSummary;
    // Its own memo, keyed on the tool-call array alone: the south bar's
    // four-second "Skipped: …" notice keys on this object's identity, and a
    // call rebuilt on every narration phrase would restart that clock.
    const lastCall = useMemo(() => {
        const tc = Array.isArray(lastToolCalls) && lastToolCalls.length ? lastToolCalls[lastToolCalls.length - 1] : null;
        // `added`: the created step(s) as a list — one entry for a single add,
        // the batch in the model's own order for `builder_add_steps`. The
        // canvas deals a burst in THIS order (useBuildChoreography's orderHint),
        // so the cards land the way the model told the story, not by flowOrder.
        return tc ? { name: tc.name, ...describeToolCall(tc, t), added: addedStepsOf(tc.result) } : null;
    }, [lastToolCalls, t]);
    // The chapter comes from the last call the server ACCEPTED, and "finalized"
    // from this turn's own calls — a refused finalize is not an ending, and
    // `state.finalizedId` outlives the turn that earned it (flow/buildChoreography.js).
    const chapter = useMemo(() => chapterOf(lastToolCalls), [lastToolCalls]);
    // When the build started, captured in the same render `running` flips
    // true (React's "adjust state while rendering" — a re-render before
    // commit, not an effect one frame later), so the banner's first frame
    // already has a clock. Kept across the flip back: the ending reports it.
    const [buildStart, setBuildStart] = useState(() => ({ running: !!state.running, at: state.running ? Date.now() : null }));
    if (buildStart.running !== !!state.running) {
        setBuildStart({ running: !!state.running, at: state.running ? Date.now() : buildStart.at });
    }
    const buildCue = useMemo(() => ({
        running: !!state.running,
        // Derived from tool names, never from the plan: everything must work
        // when the plan never arrives and when thinking is off.
        phase: chapter.phase,
        startedAt: buildStart.at,
        lastCall,
        narration: (typeof lastThinkingSummary?.text === 'string' && lastThinkingSummary.text.trim()) || null,
        todos: Array.isArray(state.todos) ? state.todos : [],
        finalizedId: chapter.finalized ? (state.finalizedId || null) : null,
        aborted: state.aborted || null,
        stepCount: (flatDef?.steps || []).length,
        // The engine behind the build and the turn's live reading/writing
        // state (hooks/useAutomationBuilderStream.js) feed the south bar's
        // engine line; the tool call being typed feeds the ghost slot.
        engine: state.engine || null,
        turn: state.turn || null,
        toolDraft: state.toolDraft || null,
    }), [state.running, lastCall, chapter, buildStart.at, lastThinkingSummary, state.todos, state.finalizedId, state.aborted, flatDef, state.engine, state.turn, state.toolDraft]);
    return buildCue;
}
