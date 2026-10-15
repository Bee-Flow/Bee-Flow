/**
 * Shared shapes for the Playbook page: the entity as the server sends it, the
 * events the page raises, and the wire forms those events turn into.
 *
 * Fields are optional where the server may leave them out; the server
 * validates the wire form, and these types only describe what the client reads.
 */

/** One phase of a playbook (a row of `playbook.phases`). */
export interface Phase {
    key: string;
    kind?: string | null;
    label?: string | null;
    status: string;
    requires?: string | null;
    brief?: string | null;
    summary?: string | null;
    error?: string | null;
    needsInput?: boolean;
    startedAt?: string | null;
    finishedAt?: string | null;
    artifacts?: Artifacts | null;
    /** How many times the phase has been attempted (a retry is a new attempt). */
    attempt?: number;
    /** Set on an optimistic `running` status the server has not confirmed yet. */
    _optimistic?: boolean;
}

/** The part of a phase the labels and tiles read (a current-phase stub has only the key). */
export type PhaseRef = Pick<Phase, 'key' | 'kind' | 'label'>;

/** The playbook entity. */
export interface Playbook {
    id: string;
    version: number;
    status?: string;
    name?: string;
    title?: string | null;
    options?: { tier?: string | null; tableMode?: string | null } | null;
    phases: Phase[];
    [field: string]: unknown;
}

/** What a phase's run reports back to the client (see `applyPhaseResult`). */
export interface PhaseResult {
    kind: string;
    artifacts?: Artifacts;
    summary?: string;
    error?: string;
}

/** An event the page raises for a phase (see `patchFor`). */
export interface PhaseEvent {
    type: string;
    key?: string;
    brief?: string;
    artifacts?: Artifacts;
    summary?: string;
    error?: string;
    nextKey?: string | null;
    feedback?: string;
    extra?: Record<string, unknown>;
    /** For `replace`: the server's answer, already in hand. */
    playbook?: Playbook | null;
}

/** What a phase's run leaves behind, as the inspector and the done card read it. */
export interface Artifacts {
    datatableId?: string | null;
    datatableName?: string | null;
    datatableKey?: string | null;
    rowCount?: number | null;
    rowsBefore?: number | null;
    isMirror?: boolean;
    hasStatus?: boolean;
    fields?: Array<{ key: string; name?: string; type?: string }>;
    mapping?: Record<string, string> | null;
    automationId?: string | null;
    automationTitle?: string | null;
    designName?: string | null;
    screenCount?: number | null;
    elementCount?: number | null;
    design?: { look?: { preset: string; accent: string } } | null;
    appId?: string | null;
    appName?: string | null;
    accessApplied?: boolean;
    findings?: unknown[];
    frameworks?: string[];
    runId?: string | null;
    runStatus?: string | null;
    briefSentAttempt?: number;
    briefSentAt?: string;
    [field: string]: unknown;
}

/** The wire form of an event: a CAS PATCH, or a POST to a server-run route. */
export type PhasePatch =
    | { method: 'PATCH'; body: Record<string, unknown> }
    | { method: 'POST'; route: string; body?: Record<string, unknown> };

/** One input a recipe asks for. */
export interface RecipeInput {
    key: string;
    label?: string;
    kind?: string;
    placeholder?: string;
    default?: unknown;
    [field: string]: unknown;
}

/** One phase of a recipe document. */
export interface RecipePhase {
    key: string;
    kind?: string;
    label?: string;
    requires?: string | null;
}

/** A recipe document (server-owned or AI-written; the client reads these fields). */
export interface Recipe {
    id: string;
    title: string;
    description?: string | null;
    source?: string;
    warnings?: string[];
    table?: { fields?: Array<{ key: string; name?: string; type?: string }> } | null;
    inputs?: RecipeInput[] | null;
    phases?: RecipePhase[] | null;
    [field: string]: unknown;
}
