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
    | 'user';

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
    /** A create form's starting value. */
    readonly initial?: FieldValue;
    /** A choice whose values travel as numbers (likelihood 1–5). */
    readonly numeric?: boolean;
    /** A choice whose options the server lists (`[{ id, label }]`), read per record. */
    readonly remote?: (rec: Rec | null) => string;
}

export type FieldValue = string | boolean;
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
}

/** Formatting helpers the registry's row titles and summaries use. */
export interface Formatter {
    readonly t: TranslateFn;
    readonly date: (value: unknown) => string | null;
    readonly user: (id: unknown) => string | null;
}

/** An attestation with an outcome, a statement and evidence files (custom checks, machinery). */
export interface AttestSpec {
    readonly outcomes: readonly Choice[];
    readonly path: (rec: Rec) => string;
    readonly subjectType: string;
    readonly checkId?: (rec: Rec) => string | null;
    readonly subjectId?: (rec: Rec) => string | null;
    readonly evidenceRequired?: (rec: Rec) => boolean;
}

export interface ActionSpec {
    readonly id: string;
    readonly label: Label;
    readonly icon?: IconName;
    readonly danger?: boolean;
    readonly when?: (rec: Rec) => boolean;
    /** Fields asked for first, in a sheet; the values reach `request`. */
    readonly fields?: readonly FieldSpec[];
    readonly confirm?: Label;
    readonly request?: (rec: Rec, values: FormValues, ctx: RequestContext) => WriteRequest;
    readonly download?: (rec: Rec) => Download;
    readonly attest?: AttestSpec;
    readonly success?: Label;
}

/** A button above a register's list (seed the templates, export the register). */
export interface ListActionSpec {
    readonly id: string;
    readonly label: Label;
    readonly icon: IconName;
    readonly when?: (set: RecordSet) => boolean;
    readonly request?: () => WriteRequest;
    readonly download?: Download;
    readonly success?: Label;
}

export interface RecordSet {
    readonly rows: readonly Rec[];
    readonly context: Rec | null;
}

export interface HistoryItem {
    readonly id: string;
    readonly title: string;
    readonly meta: string | null;
}

export interface RelatedSpec {
    readonly key: string;
    readonly title: Label;
    readonly empty: Label;
    readonly titleOf: (item: Rec, fmt: Formatter) => string;
    readonly fields: readonly FieldSpec[];
    /** What a related item offers when pressed (attest an item, delete it). */
    readonly actions?: readonly ActionSpec[];
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
    readonly detail?: { readonly path: (id: string) => string; readonly select: (raw: unknown) => Rec };
    readonly idOf: (rec: Rec) => string;
    readonly titleOf: (rec: Rec, fmt: Formatter) => string;
    /** Field keys (of `facts`) summarised under a row's title. */
    readonly meta?: readonly string[];
    readonly status?: { readonly key: string; readonly options: readonly Choice[] };
    readonly facts: readonly FieldSpec[];
    readonly search?: readonly string[];
    readonly empty: { readonly title: Label; readonly message?: Label };
    readonly create?: {
        readonly label: Label;
        readonly fields: readonly FieldSpec[];
        readonly request: (values: FormValues, ctx: RequestContext) => WriteRequest;
        readonly success?: Label;
    };
    readonly edit?: {
        readonly fields: readonly FieldSpec[];
        readonly request: (rec: Rec, patch: Record<string, unknown>, ctx: RequestContext) => WriteRequest;
        readonly success?: Label;
    };
    readonly remove?: { readonly confirm: Label; readonly request: (rec: Rec) => WriteRequest };
    readonly actions?: readonly ActionSpec[];
    readonly listActions?: readonly ListActionSpec[];
    readonly related?: RelatedSpec;
    readonly history?: {
        readonly title: Label;
        readonly path: (rec: Rec) => string;
        readonly select: (raw: unknown, fmt: Formatter) => HistoryItem[];
    };
}
