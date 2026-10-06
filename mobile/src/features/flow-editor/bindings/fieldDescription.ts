/**
 * The words on a picker row: "list of 3 · text", "group · 3 fields",
 * "table · 14 rows · 4 columns", "file · report.pdf · 12 KB". `describeField`
 * from agent-hub `Builder/mapping/fieldKinds.js`, split out so fieldKinds
 * stays free of listShape; pinned by mapping.lockstep.test.ts.
 */

import { type FieldDescription, type FieldKind, formatBytes, KIND_WORD, kindOfValue, liveValue, translatorOr } from './fieldKinds';
import { pathListShape } from './listShape';
import type { Translate, VariableField } from './types';
import { jsonTextValue } from './upstream/fieldTree';

type Params = Record<string, string | number>;

function word(kind: FieldKind, tr: Translate): string {
    return tr(KIND_WORD[kind].key, KIND_WORD[kind].en);
}

/** Every key a table's first rows carry: a key only row 2 has is still a column. */
function columnCount(rows: unknown[]): number {
    const keys = new Set<string>();
    for (const r of rows.slice(0, 50)) {
        if (r && typeof r === 'object' && !Array.isArray(r)) for (const k of Object.keys(r)) keys.add(k);
    }
    return keys.size;
}

function tableDetail(value: unknown, count: number | null, tr: Translate): string {
    const cols = Array.isArray(value) && value.length ? columnCount(value) : null;
    const rowsText = count === 1
        ? tr('automations.kind.row', '{n} row', { n: 1 })
        : tr('automations.kind.rows', '{n} rows', { n: count ?? '?' } as Params);
    const colsText = cols === 1
        ? tr('automations.kind.column', '{n} column', { n: 1 })
        : tr('automations.kind.columns', '{n} columns', { n: cols ?? '?' } as Params);
    return `· ${rowsText} · ${colsText}`;
}

function listDetail(count: number | null, elemWord: string | null, tr: Translate): string | null {
    if (count == null) return elemWord ? tr('automations.kind.list_of_kind', 'of {kind}', { kind: elemWord }) : null;
    return elemWord
        ? tr('automations.kind.list_of_n_kind', 'of {n} · {kind}', { n: count, kind: elemWord })
        : tr('automations.kind.list_of_n', 'of {n}', { n: count });
}

interface Seen {
    value: unknown;
    field: Partial<VariableField> | null | undefined;
    sampleRoot: unknown;
}

function describeCollection(kind: 'list' | 'table', { value, field, sampleRoot }: Seen, tr: Translate): FieldDescription {
    const shape = field?.path ? pathListShape(field.path, sampleRoot) : null;
    const count = shape?.count ?? (Array.isArray(value) ? value.length : null);
    const w = word(kind, tr);
    if (kind === 'table') return { kind, word: w, value, count, of: 'records', detail: tableDetail(value, count, tr) };
    const first = Array.isArray(value) ? value.find((x) => x !== null && x !== undefined) : undefined;
    const elemKind = first === undefined ? null : kindOfValue(first);
    if (count === 0) return { kind, word: w, value, count, of: null, detail: tr('automations.kind.list_empty', '· empty') };
    // A list of JSON texts reads "list of 2 · JSON", never as the raw text.
    const elemWord = jsonTextValue(first) !== undefined ? tr('automations.kind.json', 'JSON') : (elemKind ? word(elemKind, tr) : null);
    return { kind, word: w, value, count, of: elemKind, detail: listDetail(count, elemWord, tr) };
}

function longTextDetail(value: string, tr: Translate): string {
    const paragraphs = value.split(/\n\s*\n/).filter((x) => x.trim()).length;
    const words = value.trim().split(/\s+/).length;
    return paragraphs > 1
        ? tr('automations.kind.paragraphs', '· {n} paragraphs', { n: paragraphs })
        : tr('automations.kind.words', '· {n} words', { n: words });
}

/** JSON text (a body, an AI answer): what it holds, never the raw text. */
function jsonDetail(encoded: unknown, tr: Translate): string {
    const n = Array.isArray(encoded) ? encoded.length : Object.keys(encoded as object).length;
    if (Array.isArray(encoded)) return tr('automations.kind.json_list', '· JSON, a list of {n}', { n });
    return n === 1
        ? tr('automations.kind.json_record_one', '· JSON with 1 field')
        : tr('automations.kind.json_record', '· JSON with {n} fields', { n });
}

function fileDetail(value: Record<string, unknown>): string | null {
    const name = value.name || value.filename || '';
    const size = formatBytes(value.size);
    return [name, size].filter(Boolean).map((x) => `· ${String(x)}`).join(' ') || null;
}

/**
 * Describe a picker FIELD row, resolved against the merged sample root when
 * there is one. `t(key, en, params)` is optional; the app's translator
 * otherwise.
 */
export function describeField(
    field: Partial<VariableField> | null | undefined,
    sampleRoot: unknown = null,
    t: Translate | null = null,
): FieldDescription {
    const tr = translatorOr(t);
    const value = liveValue(field, sampleRoot);
    const kind = kindOfValue(value);
    if (kind === 'list' || kind === 'table') return describeCollection(kind, { value, field, sampleRoot }, tr);
    const base = { kind, word: word(kind, tr), value, count: null, of: null };
    if (kind === 'group') {
        const n = Object.keys(value as object).length;
        const detail = n === 1 ? tr('automations.kind.group_field', '· 1 field') : tr('automations.kind.group_fields', '· {n} fields', { n });
        return { ...base, count: n, detail };
    }
    if (kind === 'file') return { ...base, detail: fileDetail(value as Record<string, unknown>) };
    const encoded = kind === 'text' ? jsonTextValue(value) : undefined;
    if (encoded !== undefined) return { ...base, detail: jsonDetail(encoded, tr) };
    // "text · 2 paragraphs": a blob is not a value you read in a row.
    if (kind === 'text' && typeof value === 'string' && value.length > 120) return { ...base, detail: longTextDetail(value, tr) };
    return { ...base, detail: null };
}
