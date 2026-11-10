/**
 * The contract of the shared server walker (sequenceWalk.mts): the state it threads,
 * the host it calls, the events and outcomes it reports. Types only; sequenceWalk.mts
 * re-exports them, so its importers keep one import path.
 */

export type Obj = Record<string, unknown>;
export type Step = Obj & { kind?: string };

export type StepResult = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean; notes?: string[] };
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
    resolveCallee?(actionId: string): Obj | null;
    sleep(ms: number): Promise<void>;
    now(): number;
};

export type StepPath = { path: string; kind: string; ordinal: number | null; ownerActionId?: string };

export type OutcomeView = {
    ok: boolean; stopped: string | null; failed: WalkState['failed'];
    vars: Obj; result: unknown; steps: Map<string, Outcome>;
};
