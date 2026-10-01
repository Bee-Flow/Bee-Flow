/**
 * fieldKinds — the plain-language vocabulary for what a field IS: text, an
 * email address, a number, yes/no, a date, one of a list, a list, a group, a table, a file, or
 * "not seen yet". Never "string / array / object". `unknown` is a real answer:
 * a design-time placeholder is not evidence. The words of an output field
 * (nodeEditor/OutputFieldRow) and a tool parameter's kind (schemaForm) come
 * from here.
 *
 * Once a port of agent-hub `Builder/mapping/fieldKinds.js`, held to it by a
 * differential test. The halves that judged a picked value against a field
 * (kindFits, the mismatch sentences, describeField) went when the shared
 * mapping core took that over (shape.mjs, slots.mjs, intent.mjs), and what
 * is left is the phone's own: fieldKinds.test.ts.
 */

import type { JsonSchemaProp } from './types';

export type FieldKind = 'text' | 'email' | 'number' | 'yesno' | 'date' | 'choice' | 'list' | 'group' | 'table' | 'file' | 'unknown';

export const KINDS: readonly FieldKind[] = Object.freeze(['text', 'email', 'number', 'yesno', 'date', 'choice', 'list', 'group', 'table', 'file', 'unknown']);

/** The i18n key and English word per kind (the web's `routines.kind.*`). */
export const KIND_WORD: Readonly<Record<FieldKind, { key: string; en: string }>> = Object.freeze({
    text: { key: 'routines.kind.text', en: 'text' },
    email: { key: 'routines.kind.email', en: 'email address' },
    number: { key: 'routines.kind.number', en: 'number' },
    yesno: { key: 'routines.kind.yesno', en: 'yes/no' },
    date: { key: 'routines.kind.date', en: 'date' },
    choice: { key: 'routines.kind.choice', en: 'one of a list' },
    list: { key: 'routines.kind.list', en: 'list' },
    group: { key: 'routines.kind.group', en: 'group' },
    table: { key: 'routines.kind.table', en: 'table' },
    file: { key: 'routines.kind.file', en: 'file' },
    unknown: { key: 'routines.kind.unknown', en: 'not seen yet' },
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
