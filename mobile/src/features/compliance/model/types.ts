/**
 * The vocabulary of the Compliance Center on the phone.
 *
 * The web's hub (agent-hub/src/components/admin/compliance) is seventeen pages;
 * most of them are the same thing — a register of records with a list, a
 * drawer, a create form, a few status buttons. Here that sameness is data: a
 * `RecordType` says where a register is read, how a row is titled, which
 * fields its forms carry and which requests its buttons send, and one set of
 * generic components (RecordList, RecordDetail, RecordFormSheet) renders every
 * one of them. Copy is carried as `{ i18nKey, en }` pairs so the i18n guard
 * checks each key against both dictionaries.
 */

import type { TranslateFn } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { HubCounts } from '../api/hubReaders';

/** A translatable string, resolved with `t(i18nKey, en)` where it renders. */
export interface Label {
    readonly i18nKey: string;
    readonly en: string;
}

export type RecordTone = 'success' | 'warning' | 'error' | 'neutral' | 'info';

export interface Choice {
    readonly value: string;
    /** A plain string only for what is never translated (the digits of a 1–5 scale). */
    readonly label: Label | string;
    readonly tone?: RecordTone;
    /** Shown under the chips while this option is selected. */
    readonly hint?: Label;
}

export type FieldKind =
    | 'text'
    | 'multiline'
    | 'email'
    | 'date'
    | 'number'
    | 'choice'
    | 'bool'
    | 'lines'
    | 'user'
    /** An ISO instant, picked with presets and steppers (never in the future). */
    | 'moment'
    /** Several org members; the value and the body are string arrays. */
    | 'users'
    /** A JSON object typed as text; the body is the parsed object, empty is {}. */
    | 'json';

/** What a field's own validate() may need beyond the values. */
export interface FieldContext {
    readonly t: TranslateFn;
    readonly rec: Rec | null;
    readonly now: number;
}

export interface FieldSpec {
    /** The record key the value is read from. */
    readonly key: string;
    /** The request-body key, when it differs from `key` (a policy's draft_body goes out as body). */
    readonly body?: string;
    readonly label: Label;
    readonly kind: FieldKind;
    readonly options?: readonly Choice[];
    readonly required?: boolean;
    readonly hint?: Label;
    readonly placeholder?: Label;
    /** A create form's starting value (a function is called when the form opens). */
    readonly initial?: FieldValue | (() => FieldValue);
    /** A choice whose values travel as numbers (likelihood 1–5). */
    readonly numeric?: boolean;
    /** A choice whose options the server lists (`[{ id, label }]`), read per record. */
    readonly remote?: (rec: Rec | null) => string;
    /** A rule beyond required/format: the message, or null when the value will do. */
    readonly validate?: (value: FieldValue | undefined, values: FormValues, ctx: FieldContext) => string | null;
    /** Options that depend on the record. */
    readonly optionsFor?: (rec: Rec | null) => readonly Choice[];
    readonly hintFor?: (rec: Rec | null) => Label | null;
    readonly placeholderFor?: (rec: Rec | null) => string | null;
    /** Hidden (and not validated) while this says false. */
    readonly visible?: (rec: Rec | null, values: FormValues) => boolean;
    /** The fact's ink. */
    readonly toneOf?: (value: unknown, rec: Rec) => RecordTone | null;
    /** A live line under the input. */
    readonly preview?: (value: FieldValue | undefined, t: TranslateFn) => string | null;
    /** A warning under the field, read from the server for the current value. */
    readonly remoteWarning?: {
        readonly path: (value: FieldValue | undefined) => string | null;
        readonly select: (raw: unknown, t: TranslateFn) => string | null;
    };
    /** Adds a 'Pick a file' button that reads a text file into the field. */
    readonly fileImport?: { readonly mimeTypes: readonly string[] };
}

export type FieldValue = string | boolean | readonly string[];
export type FormValues = Record<string, FieldValue>;

/** One record as read from the server: an allow-listed, reader-checked object. */
export type Rec = Readonly<Record<string, unknown>>;

export type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface WriteRequest {
    readonly method: Method;
    readonly path: string;
    readonly body?: unknown;
}

/** A server file handed to the share sheet (a PDF, a JSON dossier). */
export interface Download {
    readonly path: string;
    readonly fileName: string;
    readonly mimeType: string;
}

/** What a request builder may need beyond the record and the form. */
export interface RequestContext {
    readonly t: TranslateFn;
    /** The register's extra payload (the management-review agenda). */
    readonly context: Rec | null;
    readonly now: number;
    /** A member's name, or null for an unknown id. */
    readonly userName?: (id: string) => string | null;
}

/** Formatting helpers the registry's row titles and summaries use. */
export interface Formatter {
    readonly t: TranslateFn;
    readonly date: (value: unknown) => string | null;
    /** A member's name; '—' for an unknown non-empty id (never a raw id); null when empty. */
    readonly user: (id: unknown) => string | null;
    /** '5 Oct 14:03', the year only when it is not this year. */
    readonly dayTime: (value: unknown) => string | null;
    /** '19 Aug 20:38:05'. */
    readonly stamp: (value: unknown) => string | null;
    /** The wall clock the screen last rendered at. */
    readonly now: number;
}

/** An attestation with an outcome, a statement and evidence files (custom checks, machinery). */
export interface AttestSpec {
    readonly outcomes: readonly Choice[];
    readonly path: (rec: Rec) => string;
    readonly subjectType: string;
    readonly checkId?: (rec: Rec) => string | null;
    readonly subjectId?: (rec: Rec) => string | null;
    readonly evidenceRequired?: (rec: Rec) => boolean;
    readonly subtitle?: (rec: Rec, fmt: Formatter) => string | null;
    readonly reference?: (rec: Rec) => string | null;
    readonly initial?: (rec: Rec) => Readonly<Record<string, unknown>> | null;
    readonly outcomeLabel?: Label;
    readonly historyPath?: (rec: Rec) => string | null;
}

/** Copy that is fixed, or depends on the record. */
type RecLabel = Label | ((rec: Rec, t: TranslateFn) => string);

export interface ActionSpec {
    readonly id: string;
    readonly label: Label;
    readonly icon?: IconName;
    readonly danger?: boolean;
    readonly when?: (rec: Rec) => boolean;
    /** Fields asked for first, in a sheet; the values reach `request`. */
    readonly fields?: readonly FieldSpec[];
    readonly confirm?: RecLabel;
    readonly request?: (rec: Rec, values: FormValues, ctx: RequestContext) => WriteRequest;
    readonly download?: (rec: Rec) => Download;
    readonly attest?: AttestSpec;
    readonly success?: Label | ((result: unknown, rec: Rec, t: TranslateFn) => string);
    readonly submitLabel?: Label;
    /** The sheet's subtitle. */
    readonly description?: Label | ((rec: Rec, t: TranslateFn) => string | null);
    /** The sheet starts from the record's values. */
    readonly prefill?: boolean;
    /** Shown disabled, with this as its caption, while it returns a label. */
    readonly disabledReason?: (rec: Rec) => Label | null;
    /** The words for a failed write (toast and sheet); null keeps the default. */
    readonly errorText?: (err: unknown, t: TranslateFn) => string | null;
    readonly afterSuccess?: 'back';
    /** Cross-field rules: field key → message. */
    readonly validate?: (values: FormValues, rec: Rec, t: TranslateFn) => Record<string, string>;
}

/** A button above a register's list (seed the templates, export the register). */
export interface ListActionSpec {
    readonly id: string;
    readonly label: Label;
    readonly icon: IconName;
    readonly when?: (set: RecordSet) => boolean;
    readonly request?: () => WriteRequest;
    readonly download?: Download;
    readonly success?: Label | ((result: unknown, t: TranslateFn) => string);
    readonly labelFor?: (set: RecordSet, t: TranslateFn) => string;
    /** Refetch the list instead of writing. */
    readonly refresh?: boolean;
}

export interface RecordSet {
    readonly rows: readonly Rec[];
    readonly context: Rec | null;
}

export interface HistoryItem {
    readonly id: string;
    readonly title: string;
    readonly meta: string | null;
    readonly tone?: RecordTone;
}

export interface RelatedSpec {
    readonly key: string;
    readonly title: Label;
    readonly empty: Label;
    readonly titleOf: (item: Rec, fmt: Formatter) => string;
    readonly fields: readonly FieldSpec[];
    /** What a related item offers when pressed (attest an item, delete it). */
    readonly actions?: readonly ActionSpec[];
    readonly status?: (item: Rec, parent: Rec) => Choice | null;
    readonly subtitleOf?: (item: Rec, fmt: Formatter, parent: Rec) => string | null;
}

/** One option of a list filter group. */
export interface RecordFilterOption {
    readonly id: string;
    readonly label: Label;
    readonly tone?: RecordTone;
    readonly match: (rec: Rec, now: number) => boolean;
}

/** A row of filter pills; the active options of all groups are ANDed. */
export interface RecordFilterGroup {
    readonly id: string;
    readonly options: readonly RecordFilterOption[];
    /** The option active at first; the first one otherwise. */
    readonly default?: string;
}

/** A deadline drawn by DeadlineClock. The server's state and pct win over local maths. */
export interface ClockSpec {
    readonly dueAt: string | number | null;
    readonly startedAt?: string | number | null;
    readonly doneAt?: string | number | null;
    readonly state?: string | null;
    readonly pct?: number | null;
    readonly urgentBelowMs?: number;
    /** Neutral ink, never red; a string replaces the words ('closed · not notified'). */
    readonly quiet?: boolean | string;
    /** The stage the clock is for, before its words. */
    readonly label?: string | null;
}

/** A register row drawn by RegisterRow instead of the plain ListRow. */
export interface RowView {
    readonly title?: string;
    readonly subtitle?: string | null;
    /** A second line. */
    readonly meta?: string | null;
    readonly badge?: { readonly label: string; readonly tone: RecordTone } | null;
    readonly clock?: ClockSpec | null;
    /** A 3px stripe on the left. */
    readonly accent?: RecordTone | null;
    readonly dimmed?: boolean;
}

export interface RecordHeaderView {
    readonly pill?: { readonly text: string; readonly tone: RecordTone } | null;
    readonly lines?: readonly string[];
}

export interface RecordErrorView {
    readonly title: Label;
    readonly message?: Label;
    readonly retry: boolean;
}

export interface RecordType {
    readonly id: string;
    /** The section of the hub this register belongs to. */
    readonly section: string;
    readonly noun: Label;
    readonly plural: Label;
    readonly icon: IconName;
    readonly intro?: Label;
    readonly list: {
        readonly paths: readonly string[];
        readonly select: (payloads: readonly unknown[]) => RecordSet;
    };
    /** A richer read of one record, merged over its list row. */
    readonly detail?: {
        readonly path: (id: string) => string;
        readonly select: (raw: unknown) => Rec;
        /** Shown when the read fails (edit, actions and related are then hidden). */
        readonly errorText?: Label;
    };
    readonly idOf: (rec: Rec) => string;
    readonly titleOf: (rec: Rec, fmt: Formatter) => string;
    /** Field keys (of `facts`) summarised under a row's title. */
    readonly meta?: readonly string[];
    readonly status?: { readonly key: string; readonly options: readonly Choice[] };
    readonly facts: readonly FieldSpec[];
    readonly search?: readonly string[];
    readonly empty: { readonly title: Label; readonly message?: Label };
    readonly filters?: readonly RecordFilterGroup[];
    /** The status line under the intro: a pill and caption lines. */
    readonly header?: (set: RecordSet, fmt: Formatter, counts: HubCounts | null) => RecordHeaderView | null;
    readonly rowView?: (rec: Rec, fmt: Formatter) => RowView;
    /** Extra text a search matches. */
    readonly searchText?: (rec: Rec, fmt: Formatter) => string;
    readonly searchPlaceholder?: Label;
    /** The tab count. */
    readonly count?: (set: RecordSet) => number | null;
    /** The detail header's subtitle. */
    readonly subtitleOf?: (rec: Rec, fmt: Formatter) => string | null;
    /** How a failed list read reads; null keeps the default error. */
    readonly errorState?: (err: unknown) => RecordErrorView | null;
    readonly create?: {
        readonly label: Label;
        readonly fields: readonly FieldSpec[];
        readonly request: (values: FormValues, ctx: RequestContext) => WriteRequest;
        readonly success?: Label | ((result: unknown, t: TranslateFn) => string);
        readonly description?: Label;
        readonly submitLabel?: Label;
        readonly validate?: (values: FormValues, t: TranslateFn) => Record<string, string>;
        readonly errorText?: (err: unknown, t: TranslateFn) => string | null;
        /** The record to open once created (from the write's response). */
        readonly openAfter?: (result: unknown) => string | null;
    };
    readonly edit?: {
        readonly fields: readonly FieldSpec[];
        readonly request: (rec: Rec, patch: Record<string, unknown>, ctx: RequestContext) => WriteRequest;
        readonly success?: Label;
        readonly when?: (rec: Rec) => boolean;
        readonly validate?: (values: FormValues, rec: Rec, t: TranslateFn) => Record<string, string>;
        readonly errorText?: (err: unknown, t: TranslateFn) => string | null;
    };
    readonly remove?: {
        readonly confirm: Label;
        readonly request: (rec: Rec) => WriteRequest;
        readonly label?: Label;
        readonly icon?: IconName;
    };
    readonly actions?: readonly ActionSpec[];
    readonly listActions?: readonly ListActionSpec[];
    readonly related?: RelatedSpec;
    readonly history?: {
        readonly title: Label;
        readonly path: (rec: Rec) => string;
        readonly select: (raw: unknown, fmt: Formatter) => HistoryItem[];
    };
}
