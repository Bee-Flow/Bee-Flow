import type { BuilderEngine, BuilderMessage, BuilderTodo, BuilderTurn, BuilderValidation, DryRun } from '../builderStream';

/** What the host already knows when it mounts the builder. */
/** What `send` carries beside the message: how to run the turn, and what the
 *  canvas and composer contribute to it. */
export interface AutomationBuilderSendOptions {
    message?: string;
    /** Set when `message` answers the builder's questions. Only the chat reads
     *  it, to show a Q/A list; the model gets `message`, which holds the same
     *  pairs as plain text. */
    answers?: Array<{ prompt: string; answer: string }> | null;
    targetAutomationId?: string | null;
    modelTier?: string;
    workMode?: string;
    alwaysPlanLarge?: boolean;
    pauseAfterStep?: boolean;
    approvedPlanId?: string | null;
    selectedStepId?: string | null;
    timezone?: string;
    history?: unknown;
    attachments?: unknown[];
    webSearchEnabled?: boolean;
    disabledMedia?: Record<string, unknown>;
    canvasScope?: unknown;
    resume?: boolean;
    seedMetadata?: unknown;
}

export interface AutomationBuilderInitial {
    automationId?: string | null;
    draft?: unknown;
    title?: string | null;
}

/** The whole builder, in one state object the shell reads. */
export interface AutomationBuilderState {
    builderSessionId: string | null;
    automationId: string | null;
    messages: BuilderMessage[];
    draft: unknown;
    /** Last definition the server confirmed; used to detect local divergence. */
    lastServerDraft: unknown;
    /** An SSE draft that arrived while the user had local edits — surfaced to
     *  the UI for accept/discard. */
    pendingExternalDraft: unknown;
    summary: string;
    hasSideEffects: boolean;
    dryRun: DryRun | null;
    steps: Array<Record<string, unknown>>;
    finalizedId: string | null;
    running: boolean;
    /** Id of the step currently mid partial-execute (n8n-style ▶). */
    executingStepId: string | null;
    error: string | null;
    validation: BuilderValidation | null;
    /** { reason, iterations, lastValidation } when the builder ran out of iterations. */
    aborted: Record<string, unknown> | null;
    /**
     * The server's own verdict on the LAST turn, from its terminal `done`
     * event: { finalized, automationId, iterations }. `finalizedId` is sticky
     * across turns (only reset() clears it); a host that needs to know how
     * THIS turn ended (a Playbook phase) reads this instead.
     */
    lastDone: Record<string, unknown> | null;
    /** The agent's self-managed plan — a read-only checklist. */
    todos: BuilderTodo[];
    reviewPlan: Record<string, unknown> | null;
    reviewQuestions: unknown[] | null;
    /** The approved plan whose build asked these questions (the build is paused on them); null for a plain plan-mode round. */
    reviewQuestionsPlanId: string | null;
    proposal: Record<string, unknown> | null;
    /** Bookkeeping for the CURRENT turn's silence before the first token; see
     *  openTurn(). Reset on every send; null until the first one. */
    turn: BuilderTurn | null;
    /** The tool call the model is TYPING right now (server `tool_draft`).
     *  Feeds the ghost slot and the ribbon spotlight; null between calls. */
    toolDraft: Record<string, unknown> | null;
    /** Last known facts about the engine behind the build, kept ACROSS turns
     *  for the south bar. Null until the first round_start. */
    engine: BuilderEngine | null;
    /** Bumped on every `dryrun` event so the canvas can replay the run step by
     *  step (BuildTab useDryRunReplay) — the rows land in `steps` at once. */
    dryRunSeq: number;
    /** The automation's name as the server last reported it (`metadata`), and a
     *  counter bumped on each so the shell can refetch the header row. */
    title: string | null;
    metadataSeq: number;
    /** The last turn's answer about the Web search toggle (`web_search`): on
     *  but unusable (no provider, not permitted, file policy) carries the
     *  reason, so the composer can disable the switch instead of offering a
     *  dead one. Null until a turn reported it. */
    webSearch: BuilderWebSearchStatus | null;
}

export interface BuilderWebSearchStatus {
    requested: boolean;
    available: boolean;
    reason: string | null;
}
