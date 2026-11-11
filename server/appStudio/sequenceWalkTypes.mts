/**
 * The contract of the shared server walker (sequenceWalk.mts): the state it threads,
 * the host it calls, the events and outcomes it reports. Types only; sequenceWalk.mts
 * re-exports them, so its importers keep one import path.
 */

export type Obj = Record<string, unknown>;
export type Step = Obj & { kind?: string };

/**
 * A step that has to wait: `{ ok: true, pause }` (build it with runPause.mts). The walk stops
 * there, the host stores where it was, and a later resume completes the step with a result.
 *
 *   until          epoch ms: the wake job continues the run then
 *   kind, ref      what the run waits for besides time ('approval' and the approval's id): a
 *                  server-side resume has to name the same pair
 *   tokenHash      sha256 (hex) of a resume token: over HTTP only its holder may resume
 *   timeoutResult  the step's result when `until` passes without a resume. Left out on a pause
 *                  with a `kind` or a `tokenHash`: the step then fails with `pause_expired`
 *   waitingFor     display only: who or what the run waits for (the run tray reads it)
 */
export type PauseRequest = {
    until?: number | null; kind?: string | null; ref?: string | null; tokenHash?: string | null; timeoutResult?: unknown;
    /** Who or what the run waits for, as the run tray shows it (await_approval: who decides). Display only. */
    waitingFor?: Obj | null;
};

export type StepResult = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean; notes?: string[]; pause?: PauseRequest };

/** Where a walk paused: the step, what it asked for, and the walk state as JSON (sequenceWalkPause.mts). */
export type PausedWalk = { path: string; kind: string; ordinal: number | null; ownerActionId: string; request: PauseRequest; state: Obj };

/** How a paused step ends when its walk is resumed: with a result, or as a failure its onError / try can take. */
export type ResumeOutcome = { result: unknown } | { error: string; code: string };
export type Decision =
    | { run: true; step: Step; note?: string }
    | { run: false; status: 'skipped' | 'refused' | 'deferred'; reason: string; result?: unknown };

export type StepEvent = {
    path: string; kind: string; ordinal: number | null; ownerActionId: string;
    /** `loop.count` 0: an open loop (a while), whose number of rounds is not known up front. */
    iteration: number | null; loop: { index: number; count: number } | null;
};
export type StepStatus = 'ok' | 'error' | 'skipped' | 'refused' | 'deferred';
export type StepEndEvent = StepEvent & {
    status: StepStatus; ms: number;
    error?: string; code?: string; mocked?: boolean; attempts?: number; handled?: boolean; result?: unknown;
    /** A remark on a step that ran (e.g. "dryRun: writeTo not applied"). */
    note?: string;
};

export type Outcome = {
    path: string; kind: string; ordinal: number | null;
    status: StepStatus | 'not_run';
    result?: unknown; error?: string; code?: string; prompt?: string; note?: string;
    mocked?: boolean; ms: number;
    /** Attempts of a retried step (only when more than one). */
    attempts?: number;
    /** The step failed and its onError handler ran. */
    handled?: boolean;
    /** How often the path ran (a loop body runs once per iteration; the outcome is the last). */
    count: number;
};

export type WalkState = {
    vars: Obj; form: Obj; item: unknown; index: unknown; value: unknown;
    params: Obj;
    error?: Obj;
    lastResult: unknown; executed: number; stopped: string | null;
    /** The stop came from a budget (shouldStop), not from a failing step. */
    truncated: boolean;
    /** `step`: the kind that really failed when it is not `kind` (a step inside a called action), for error.step. */
    failed: { path: string; kind: string; ordinal: number | null; error: string; code?: string; step?: string } | null;
    /** Leaving early (sequenceWalkFlow.mts): a return on its way to the action boundary, a break or continue on its way to its loop. */
    signal?: 'return' | 'break' | 'continue' | null;
    callChain: string[];
    deferred: Obj[];
    outcomes: Map<string, Outcome>;
    /** Every walker path of the action with its kind (stepPaths), set by walkAction. */
    known: Map<string, string>;
    /** Remarks for the caller ("looped 200 of 450 rows"), each prefixed with its path. */
    notes: Set<string>;
    /** What the containers being walked need to be entered again after a pause, by key (sequenceWalkPause.mts). */
    frames?: Map<string, Obj>;
    /** Set when a step paused the walk (with `stopped` and `truncated`): nothing after it ran. */
    paused?: PausedWalk | null;
    /** A resumed walk on its way back to the step it paused at; cleared when that step is completed. */
    resume?: { path: string; frames: Record<string, Obj>; outcome: ResumeOutcome } | null;
};

export type WalkHost = {
    decide(step: Step, f: StepEvent, w: WalkState): Promise<Decision>;
    execute(step: Step, f: StepEvent, w: WalkState): Promise<StepResult>;
    mockFor?(path: string, step: Step): { value: unknown } | null;
    /** `attempt` (1-based) picks the answer of a `$sequence` mock. */
    mocked?(step: Step, value: unknown, ctx: Obj, attempt?: number): StepResult;
    resolve(binding: unknown, ctx: Obj, scope: unknown): Promise<unknown>;
    evaluate(expr: string, scope: unknown): unknown;
    buildScope(ctx: Obj): unknown;
    ctxFor(w: WalkState, f: StepEvent): Obj;
    promptOf?(step: Step, ctx: Obj): string | undefined;
    onStepStart?(e: StepEvent): void | Promise<void>;
    onStepEnd?(e: StepEndEvent): void | Promise<void>;
    onVar?(name: string, value: unknown): void;
    shouldStop?(w: WalkState): string | null;
    /** Awaited before every step of a list, ahead of shouldStop: where a host looks something up (a cancel request). */
    beforeStep?(w: WalkState): Promise<void>;
    /** True: a step may pause this walk. Otherwise a step that asks to pause fails with `pause_unsupported`. */
    canPause?: boolean;
    /** Asked before a pause is taken: `{ error, code }` fails the step instead (a limit of the host). */
    acceptPause?(request: PauseRequest, state: Obj, f: StepEvent): Promise<{ error: string; code: string } | null>;
    /** Set: the branches of a `parallel` step are walked one after another, and this text says so in a note (the dry run). */
    sequentialBranches?: string;
    resolveCallee?(actionId: string): Obj | null;
    sleep(ms: number): Promise<void>;
    now(): number;
};

export type StepPath = { path: string; kind: string; ordinal: number | null; ownerActionId?: string };

export type OutcomeView = {
    ok: boolean; stopped: string | null; failed: WalkState['failed'];
    vars: Obj; result: unknown; steps: Map<string, Outcome>;
};
