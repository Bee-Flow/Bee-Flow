/**
 * The draft store's shape: one open routine's definition as the editor holds
 * it, what the server last confirmed, the save pipeline's state, the undo
 * history and the findings — plus the actions that change them.
 */

import type { StoreApi } from 'zustand/vanilla';

import type { FlowAutomation, IssueSet, SaveResult } from '../api/types';
import type { HistoryState } from '../model/history';
import type { StepIssues } from '../model/issues';
import type { DefinitionInput, FlowDefinition } from '../model/types';

/**
 * A pure edit: the model's operations (applyAddNode, applyPatchStep,
 * applyDeleteNodes, …) fit as they are. Returning the SAME definition, a
 * structurally equal one, or nothing is "no change" — nothing is recorded or
 * saved.
 */
export type DraftOp = (definition: FlowDefinition) => DefinitionInput | FlowDefinition;

/**
 * `pending`: edits wait for the debounce; `saving`: a request is out;
 * `saved`: the server holds exactly what is on screen; `error`: see saveError.
 */
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface SaveError {
    /**
     * `transient`: the network or the server failed — retried with backoff,
     * then left for the next edit or `retry()`; a failed CREATE is the
     * exception, left for `retry()` alone (it may have landed). `permanent`: the server
     * refused THIS definition (a 400 with details, a 403, a 404) — not
     * retried; the next edit tries again.
     */
    kind: 'transient' | 'permanent';
    /** What was thrown; `describeError` (core/api/errors) turns it into words. */
    error: unknown;
    status: number | null;
    code: string | null;
    /** A transient failure with another attempt already scheduled. */
    willRetry: boolean;
}

/**
 * Where findings come from. Each source is replaced wholesale by its next
 * answer: every save's warnings (or its 400 details), the last activation
 * attempt's details, the AI builder's last `validation_errors`.
 */
export type IssueSource = 'save' | 'activate' | 'builder';
export type IssueSources = Record<IssueSource, IssueSet>;

export interface DraftData {
    /** Null until the row exists (a new routine is created on its first edit). */
    automationId: string | null;
    /** False until there is a definition to edit (the load has not answered yet). */
    ready: boolean;
    definition: FlowDefinition | null;
    /** What the server last confirmed. */
    baseline: FlowDefinition | null;
    /** The server row's version the baseline belongs to; older loads are ignored. */
    version: number | null;
    dirty: boolean;
    status: SaveStatus;
    saveError: SaveError | null;
    lastSavedAt: number | null;
    history: HistoryState<FlowDefinition>;
    canUndo: boolean;
    canRedo: boolean;
    issueSources: IssueSources;
    /** Every source merged, duplicates dropped. */
    issues: IssueSet;
    /** `issues` per step id (model/issues.ts buildIssuesByStep), for the badges. */
    issuesByStep: Map<string, StepIssues>;
    /** Edits are refused while the AI builder streams into this routine. */
    locked: boolean;
}

export interface DraftActions {
    /** Adopt the server's definition — on load, or a newer one while nothing is unsaved. */
    hydrate: (definition: FlowDefinition, version?: number | null) => void;
    /** Apply a pure edit; returns the new definition, or null when nothing changed (or edits are locked). */
    applyOp: (op: DraftOp) => FlowDefinition | null;
    undo: () => boolean;
    redo: () => boolean;
    /**
     * Swap in a whole definition (an AI draft, a restored version) as ONE undo
     * entry — while locked, one entry for the whole turn. `persisted` means
     * the server already holds it, so nothing is sent.
     */
    replaceDefinition: (definition: FlowDefinition, opts?: { persisted?: boolean; version?: number | null }) => void;
    setLocked: (locked: boolean) => void;
    setIssues: (source: IssueSource, issues: IssueSet | null) => void;
    /** The row was created elsewhere (the AI builder's first turn). */
    adoptAutomationId: (id: string) => void;
    /** Save now; resolves true once the server holds what is on screen. */
    flush: () => Promise<boolean>;
    /** Try a failed save again. */
    retry: () => Promise<boolean>;
    /** The row's id, creating the row (with the current definition) when there is none yet. */
    ensureCreated: () => Promise<string>;
    /** Stop the timers. The store is not usable afterwards. */
    dispose: () => void;
}

export type DraftState = DraftData & DraftActions;
export type DraftStore = StoreApi<DraftState>;

/** What the store needs from outside; the hook passes the api calls, a test passes fakes. */
export interface DraftDeps {
    save: (automationId: string, definition: FlowDefinition) => Promise<SaveResult>;
    create: (body: { title: string; definition: FlowDefinition }) => Promise<SaveResult>;
    /** After every successful save, with the server's row. */
    onSaved?: (result: SaveResult) => void;
    /** Once, when the lazily created row exists. */
    onCreated?: (automation: FlowAutomation) => void;
    now?: () => number;
    /** Quiet time before a save (default 900 ms). */
    delayMs?: number;
    /** Backoff between retries of a transient failure (default 1 s, 3 s, 8 s). */
    retryDelaysMs?: readonly number[];
}

export interface DraftOptions {
    automationId: string | null;
    /** The definition a NEW routine starts from (not saved until the first edit). */
    seed?: FlowDefinition | null;
    /** The new row's title. */
    title?: string;
    deps: DraftDeps;
}
