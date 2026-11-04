import { type ManagedBannerInfo } from '../utils/managedPart';

/**
 * A failed request. `status` is always set by `send`/`stepSend`, `code` only
 * when the route sent a machine code, `retryAfter` only for a 429 scan, and
 * `details` only when the route rejected a definition with the validator's
 * structured records (the builder shows those on the canvas, BFSF-58).
 */
export interface AutomationApiError extends Error {
    status?: number;
    code?: string;
    retryAfter?: number;
    details?: unknown[];
    /**
     * The object a refusal carries beside its code, when it is one rather than
     * validator records: 409 side_effects_need_confirm answers
     * { steps, missingUpstream }, the steps a ▶ Execute would run for real first.
     */
    refusal?: Record<string, unknown>;
    /**
     * Set when the stage that manages this automation refused the write (409
     * `managed_part`) or the run (409 `managed_part_not_deployed`): what the
     * ManagedPartBanner needs. A save that fails this way is not a conflict and
     * not a validation problem, and must never be retried or "kept".
     */
    managed?: ManagedBannerInfo;
}

/** `{ triggerProvider, triggerEvent? }` — narrows to the automations wired to
 *  one app-event provider. Anything else is dropped rather than sent. */
export interface AutomationListFilter {
    triggerProvider?: string;
    triggerEvent?: string;
}

export interface RunQuery {
    limit?: number;
    cursor?: string;
    automationId?: string;
    kind?: string;
    status?: string | string[];
    trigger?: string | string[];
    triggerKind?: string | string[];
    mode?: string | string[];
    since?: string;
    until?: string;
}

/**
 * When a run start answers (server core/automationRunner/startCapped.mts):
 * 'created' answers 202 { runId } as soon as the run exists, so the builder
 * follows it by id; 'finished' (the server's default) waits for the end, up to
 * the response cap, and answers 200 { run, steps } or a 202 { runId } past it.
 */
export type RunRespond = 'created' | 'finished';

/** POST /:id/run and /:id/dry-run. */
export interface RunStartBody {
    /** What the run enters with: a form's answers, the trigger's saved sample. */
    triggerPayload?: unknown;
    /** A trigger other than the primary one (definition.triggers[]). */
    triggerStepId?: string | null;
    respond?: RunRespond;
    /** /run only: run the working copy as a test run. */
    test?: boolean;
    /** /dry-run only: approvals and form pages pause for real, the author answers them. */
    pauses?: 'real';
    /** /dry-run only: play the form answers and decisions of that earlier run of this automation. */
    answersFromRunId?: string;
}

/** POST /:id/steps/:stepId/run ("Execute step"). */
export interface PartialRunBody {
    mode?: 'only' | 'from' | 'upTo';
    triggerPayload?: unknown;
    triggerStepId?: string | null;
    seedRunId?: string | null;
    allowLiveUpstream?: boolean;
    /** The person's yes to earlier steps that send or write (else 409 side_effects_need_confirm). */
    confirmSideEffects?: boolean;
    respond?: RunRespond;
}

/** POST /:id/form-test: page one of a form, answered in the builder's overlay, through the form's own submission path. */
export interface FormTestBody {
    /** The answers, as a visitor's browser posts them (a file question carries its fileId). */
    values: Record<string, unknown>;
    /** A form trigger other than the primary one. */
    triggerStepId?: string | null;
    /** 'dry' simulates every write and pauses for real; 'live' is a test run with real effects. */
    mode: 'dry' | 'live';
    /** The run ends after this step (a step the form reaches); left out, the whole flow runs. */
    untilStepId?: string;
    respond?: RunRespond;
}

/** POST /runs/:runId/form: answer the page a run waits on, and continue it. */
export interface RunFormBody {
    stepId?: string;
    values: Record<string, unknown>;
    respond?: RunRespond;
}

/** What a run start answers: the finished run, a run to follow by id, or a skip. */
export interface RunStartReply {
    accepted?: boolean;
    pending?: boolean;
    skipped?: boolean;
    message?: string;
    runId?: string;
    run?: { id?: string; status?: string; [key: string]: unknown };
    steps?: unknown;
}

export interface FacetQuery {
    /** Hours of history the counts cover. */
    range?: number;
    automationId?: string;
    kind?: string;
    mode?: string | string[];
}

export interface ApprovalQuery {
    scope?: string;
    status?: string | string[];
    cursor?: string;
    limit?: number;
    appId?: string;
    automationId?: string;
    q?: string;
}

export interface RunStreamOptions {
    automationId?: string | null;
    signal?: AbortSignal;
    onEvent?: (type: string, data: unknown) => void;
}

export type SseEventHandler = (event: string, data: unknown) => void;

/**
 * The sentence to show, the machine code beside it when the route sent one,
 * and the validator's records when it rejected a definition.
 */
export interface ErrorBody {
    message: string;
    code: string | null;
    details: unknown[] | null;
    /** The refusal's own object `details` (not validator records), e.g. { steps, missingUpstream }. */
    refusal: Record<string, unknown> | null;
    /** The managed-part refusal this body is, when it is one (409 managed_part[_not_deployed]). */
    managed: ManagedBannerInfo | null;
}

/** One validator detail as the server sends it. */
export interface ValidatorDetail {
    message?: string;
    code?: string;
    hint?: string;
}
