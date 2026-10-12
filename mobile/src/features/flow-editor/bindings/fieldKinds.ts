/**
 * fieldKinds — the plain-language vocabulary for what a field IS: text, an
 * email address, a number, yes/no, a date, one of a list, a list, a group, a table, a file, or
 * "not seen yet". Never "string / array / object". `unknown` is a real answer:
 * a design-time placeholder is not evidence. `describeField` (the picker row's
 * words) lives in fieldDescription.ts beside listShape. Port of agent-hub
 * `Builder/mapping/fieldKinds.js`; pinned by mapping.lockstep.test.ts.
 */

import { translate } from '@/core/i18n';

import type { JsonSchemaProp, Translate, VariableField } from './types';
import { walkPath } from './walkPath';

export type FieldKind = 'text' | 'email' | 'number' | 'yesno' | 'date' | 'choice' | 'list' | 'group' | 'table' | 'file' | 'unknown';

export const KINDS: readonly FieldKind[] = Object.freeze(['text', 'email', 'number', 'yesno', 'date', 'choice', 'list', 'group', 'table', 'file', 'unknown']);

/** The i18n key and English word per kind (the web's `automations.kind.*`). */
export const KIND_WORD: Readonly<Record<FieldKind, { key: string; en: string }>> = Object.freeze({
    text: { key: 'automations.kind.text', en: 'text' },
    email: { key: 'automations.kind.email', en: 'email address' },
    number: { key: 'automations.kind.number', en: 'number' },
    yesno: { key: 'automations.kind.yesno', en: 'yes/no' },
    date: { key: 'automations.kind.date', en: 'date' },
    choice: { key: 'automations.kind.choice', en: 'one of a list' },
    list: { key: 'automations.kind.list', en: 'list' },
    group: { key: 'automations.kind.group', en: 'group' },
    table: { key: 'automations.kind.table', en: 'table' },
    file: { key: 'automations.kind.file', en: 'file' },
    unknown: { key: 'automations.kind.unknown', en: 'not seen yet' },
});

/** What the kind is underneath — for tooltips and the schema bridge. */
export const KIND_TECHNICAL: Readonly<Record<FieldKind, string>> = Object.freeze({
    text: 'string', email: 'string (email)', number: 'number', yesno: 'boolean', date: 'datetime',
    choice: 'string (one of)',
    list: 'array', group: 'object', table: 'array of objects', file: 'file', unknown: '?',
});

/** The ONE ISO-date regex. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

/** One e-mail address, nothing around it: "Jan <jan@x.nl>" or a list stays text. */
export const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

/** A design-time placeholder (`'<string>'`) — not data. */
export function isPlaceholder(v: unknown): boolean {
    return typeof v === 'string' && /^<[a-z_ ]+>$/i.test(v.trim());
}

/** The shape samplePlaceholderFor('file') emits: a reference, a name and some metadata. */
export function looksLikeFile(v: unknown): boolean {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    const hasRef = 'url' in o || 'fileId' in o;
    const hasName = typeof o.name === 'string' || typeof o.filename === 'string';
    const hasMeta = 'size' in o || 'mime' in o || 'mimeType' in o;
    return hasRef && hasName && hasMeta;
}

/** Is every sampled element an object? Then it reads as a table. */
export function looksTabular(list: unknown[]): boolean {
    const sample = list.slice(0, 20).filter((v) => v !== null && v !== undefined);
    if (!sample.length) return false;
    const objects = sample.filter((v) => typeof v === 'object' && !Array.isArray(v));
    return objects.length >= sample.length / 2;
}

/** The kind of ONE value. */
export function kindOfValue(v: unknown): FieldKind {
    if (v === null || v === undefined) return 'unknown';
    if (Array.isArray(v)) return v.length > 0 && looksTabular(v) ? 'table' : 'list';
    if (typeof v === 'number' || typeof v === 'bigint') return 'number';
    if (typeof v === 'boolean') return 'yesno';
    if (typeof v === 'string') {
        if (isPlaceholder(v)) return 'unknown';
        if (ISO_DATE_RE.test(v.trim())) return 'date';
        return EMAIL_RE.test(v.trim()) ? 'email' : 'text';
    }
    if (typeof v === 'object') return looksLikeFile(v) ? 'file' : 'group';
    return 'unknown';
}

/** "12 KB" from a byte count; null when not a number. */
export function formatBytes(n: unknown): string | null {
    const b = Number(n);
    if (!Number.isFinite(b) || b < 0) return null;
    if (b < 1024) return `${Math.round(b)} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FieldDescription {
    kind: FieldKind;
    word: string;
    detail: string | null;
    value: unknown;
    count: number | null;
    of: string | null;
}

/**
 * What KIND a tool parameter wants, from its JSON schema. A declared `enum`
 * is the evidence `choice` needs; `format` still wins (a dated enum is a date).
 */
export function expectedKindFor(schemaProp: JsonSchemaProp | null | undefined): FieldKind {
    if (!schemaProp || typeof schemaProp !== 'object') return 'unknown';
    const type = primaryType(schemaProp.type);
    const fmt = String(schemaProp.format || '').toLowerCase();
    const dated = fmt === 'date' || fmt === 'date-time';
    if (isChoice(schemaProp, type, dated)) return 'choice';
    if (type === 'string') {
        if (dated) return 'date';
        return fmt === 'email' ? 'email' : 'text';
    }
    if (type === 'array') return schemaProp.items?.type === 'object' ? 'table' : 'list';
    const key = String(type);
    return Object.hasOwn(SCHEMA_KIND, key) ? (SCHEMA_KIND[key] as FieldKind) : 'unknown';
}

/** The first non-null member of a `type` union. */
function primaryType(type: unknown): unknown {
    if (!Array.isArray(type)) return type;
    return type.find((x) => x !== 'null') || type[0];
}

/** A declared option list on a (possibly untyped) string that is not a date. */
function isChoice(prop: JsonSchemaProp, type: unknown, dated: boolean): boolean {
    const hasEnum = Array.isArray(prop.enum) && prop.enum.length > 0;
    return hasEnum && (type === 'string' || type === undefined) && !dated;
}

const SCHEMA_KIND: Record<string, FieldKind> = { number: 'number', integer: 'number', boolean: 'yesno', object: 'group' };

/** Is this kind a single value (not a list, table or group)? */
export function isScalarKind(kind: unknown): boolean {
    return kind === 'text' || kind === 'email' || kind === 'number' || kind === 'yesno'
        || kind === 'date' || kind === 'choice';
}

/**
 * Would a field of `actual` kind fit a slot that wants `expected`? Advisory:
 * text and choice take any scalar, an address slot takes plain text too (most
 * addresses arrive as text), a list takes a table, unknown fits.
 */
export function kindFits(actual: unknown, expected: unknown): boolean {
    if (!expected || expected === 'unknown' || !actual || actual === 'unknown') return true;
    if (actual === expected) return true;
    if (expected === 'text' || expected === 'choice') return isScalarKind(actual);
    if (expected === 'email') return actual === 'text';
    if (expected === 'list') return actual === 'table';
    return false;
}

/** The translator describeField and mismatch use: the caller's, or the app's own. */
export function translatorOr(t: Translate | null | undefined): Translate {
    return t || translate;
}

/** Resolve a field's live value against the merged sample root, when there is one. */
export function liveValue(field: Partial<VariableField> | null | undefined, sampleRoot: unknown): unknown {
    if (sampleRoot && field?.path) {
        const live = walkPath(field.path, sampleRoot);
        if (live !== undefined) return live;
    }
    return field?.sample;
}
