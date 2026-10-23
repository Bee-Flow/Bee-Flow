import type { FormRecord } from './formState/types';
import type { Group } from '../../mapping/upstream/upstream.types';
import type { OnFocusField } from '../../mapping/focusField.types';
import type React from 'react';
import type { JSX } from 'react';

/** What every step editor receives from the settings form. */
export interface StepEditorProps {
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
    groups?: Group[];
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
}

/**
 * "Run once per item" — turns a step into a per-item iterator over an
 * upstream array (`step.forEach`). The runner runs the step once per
 * element with `loop.<itemVar>` bound; auto-map sets this up automatically
 * when you wire an array source into a step whose inputs match the elements.
 */
export interface ForEachSectionProps {
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
    onFocusField?: OnFocusField | null;
    groups?: Group[];
    children?: React.ReactNode;
}

/**
 * The waiting, added up in the author's own terms, or nothing at all when the
 * tries are immediate. Amber past half the default run budget, where the
 * waiting alone is the thing that ends the run.
 */
export interface RetryWaitTotalProps {
    tries: number;
    waitMs: number;
    rowCap: number;
}

/**
 * "If this fails" — the step-level retry the runner has honoured all along
 * (`step.retry = { max, backoffMs }`, core/automationRunner/execution.js) and
 * that no screen could ever ask for. That code is complete: it sleeps
 * `backoffMs` between attempts, records EVERY attempt in the run history
 * rather than only the last (so a flaky tool is visible instead of looking
 * like one clean failure), and stands back when a forEach already retried per
 * item (`err.foreachHandled`) so a fan-out is never re-run whole. Meanwhile a
 * timeout, a rate limit or a 503 — the three commonest ways a real
 * integration automation dies — took the whole run down, because the only way
 * to set the field was to hand-edit the JSON.
 *
 * The words here are the consequence, never the mechanism: "Try again", not
 * "retry policy"; "Wait before trying again", not "backoff". And the row
 * spells out what happens when the tries run out, because that is the
 * question an author actually has, and the answer is reassuringly boring:
 * nothing new, the step fails exactly as it does today.
 *
 * TWO CLOSED LISTS, NOT TWO NUMBER FIELDS. `retry` has no validator at all
 * — grep automation/validate.js for it — so whatever this row writes is
 * what the runner sleeps on. A free-text field here is one fat finger away
 * from `backoffMs: 300000`, and a retry's sleep does NOT re-arm the run
 * deadline the way a Wait step's does (execution.js extends the timer only
 * for planned waits), so that typo does not retry anything: it parks the run
 * until the 5-minute budget kills it, reported as a timeout on a step that
 * had merely been asked to wait. A list of six values cannot be mistyped, and
 * it sidesteps BFSF-345 as well — the clear-and-retype trap that number
 * fields in this form keep falling into.
 *
 * A value that is NOT on the list (an AI-built step, or a hand-edited one) is
 * shown as its own option rather than snapped onto the nearest neighbour.
 * Same rule as PathField: opening a step is not consent to rewrite it, and a
 * mount-time normalisation shows up later as a diff the author never made.
 *
 * WHY THIS RENDERS ONLY WHEN `retry` IS ALREADY A KEY IN THE DRAFT:
 * formState's extractFormState and buildPatch are per-type allow-lists, so a
 * control whose value buildPatch drops looks saved, saves nothing, and is
 * gone on the next open — flushNow compares the patch the draft builds with
 * the patch the baseline builds, finds them equal, and never calls the server
 * at all. This product has shipped exactly that bug twice (datatable's
 * Iteration toggle, C12; integration_action's askOnce tick) and both
 * post-mortems are still in formState.js. RETRY_FORM_TYPES is the list that
 * decides, and it is the same list in both directions: a type on it gets
 * `retry` in its draft and applyRetryPatch on the way out, and a type off it
 * gets no row rather than a lying one. The gate is the key's PRESENCE, not
 * the list, so the row cannot outlive its own round-trip if the list is ever
 * narrowed.
 */
export interface RetrySectionProps {
    draft: FormRecord;
    set: (arg0: string, arg1: { max: number; backoffMs: number; } | null) => void;
}

/**
 * Shared "fields" section for the two `draft.fields`-backed editors (`set`
 * and `layer_output`): a keep-empty ToolInputForm inside an AccordionSection.
 * Only the stepType, title/label, and hint differ.
 */
export interface FieldsSectionProps {
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
    stepType: string;
    title: string;
    hint: string;
    footer?: JSX.Element | null;
    inputProps?: { nameLabel: string; valueLabel: string; namePlaceholder: string; valuePlaceholder: string; allowRawValues: boolean; } | null;
}

/**
 * The one-line "Working through ‹gmail search› · Results — 10 items" row with
 * its `change` reveal. Shared by the Condition editor (RouteFields) and the Edit
 * data editor so the two list-mode steps read identically on screen.
 */
export interface SourceSummaryRowProps {
    onPatch: (patch: { source: string | number } | { maxItems: string | number }) => void;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    hint: string;
    warning?: string | null;
    source?: string;
    maxItems?: unknown;
    groups: Group[] | null;
}

export interface CollectionArrayRefFieldProps {
    draft: FormRecord;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    set: (arg0: string, v: string | number) => void;
    groups?: Group[] | null;
}

export type DateTimeFieldsProps = StepEditorProps;

export interface WaitFieldsProps {
    draft: FormRecord;
    set: (arg0: string, arg1: number) => void;
    errorSections?: Set<string>;
}

export type LimitFieldsProps = StepEditorProps;

export type DedupeFieldsProps = StepEditorProps;

export type AggregateFieldsProps = StepEditorProps;

export type SummarizeFieldsProps = StepEditorProps;
