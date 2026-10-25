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
    /** The managed-part refusal this body is, when it is one (409 managed_part[_not_deployed]). */
    managed: ManagedBannerInfo | null;
}

/** One validator detail as the server sends it. */
export interface ValidatorDetail {
    message?: string;
    code?: string;
    hint?: string;
}
