/**
 * "Delivers" — the fields a skill hands back (`skills.output_schema`), read
 * and edited as the web's OutputFieldsCard does.
 *
 * The schema is the same shape as an AI step's `outputSchema`, so an
 * automation that applies the skill takes its outgoing fields from here. Each
 * field is read back in the product's field-kind words (`text`, `number`,
 * `yes/no`, `date`, `one of a list`, `list`, `table`, `group`) — the words an
 * automation shows when it binds the field — via `expectedKindFor`, a port of
 * agent-hub mapping/fieldKinds.js.
 *
 * Editing works ON the schema, never through a lossy row model: a field this
 * phone did not touch keeps its spec byte for byte (a table's columns, an
 * enum, a nested object). Only the field being changed is rewritten, and only
 * to one of the four scalar kinds a phone form can honestly offer.
 *
 * `null` is a real answer: no fields means "this skill answers in its own
 * words", and an empty properties object would be a different claim — so
 * removing the last field yields `null`, as the web's fieldsToSchema does.
 */

import type { OutputSchema } from './types';

export type FieldKind = 'text' | 'number' | 'yesno' | 'date' | 'choice' | 'list' | 'table' | 'group' | 'unknown';

/** The kinds a phone can create or switch a field to. */
export const EDITABLE_KINDS = Object.freeze(['text', 'number', 'yesno', 'date'] as const);
export type EditableKind = (typeof EDITABLE_KINDS)[number];

/** routes/kind words the web shows for each kind (fieldKinds.js KIND_WORD). */
export const KIND_WORD: Readonly<Record<FieldKind, { key: string; en: string }>> = {
    text: { key: 'automations.kind.text', en: 'text' },
    number: { key: 'automations.kind.number', en: 'number' },
    yesno: { key: 'automations.kind.yesno', en: 'yes/no' },
    date: { key: 'automations.kind.date', en: 'date' },
    choice: { key: 'automations.kind.choice', en: 'one of a list' },
    list: { key: 'automations.kind.list', en: 'list' },
    group: { key: 'automations.kind.group', en: 'group' },
    table: { key: 'automations.kind.table', en: 'table' },
    unknown: { key: 'automations.kind.unknown', en: 'not seen yet' },
};

/** A field key the server's validateOutputSchema accepts: letters, digits, underscore. */
export const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface OutputField {
    key: string;
    kind: FieldKind;
    unit: string;
    description: string;
    required: boolean;
}

type Spec = Record<string, unknown>;

const isObj = (v: unknown): v is Spec => !!v && typeof v === 'object' && !Array.isArray(v);

function propsOf(schema: OutputSchema | null | undefined): Spec {
    return isObj(schema) && isObj(schema.properties) ? schema.properties : {};
}

/** The kind of a string field: a date, one of a list, or text. */
function stringKind(spec: Spec, typed: boolean): FieldKind | null {
    const fmt = String(spec.format || '').toLowerCase();
    const dated = fmt === 'date' || fmt === 'date-time';
    if (Array.isArray(spec.enum) && spec.enum.length && !dated) return 'choice';
    if (!typed) return null;
    return dated ? 'date' : 'text';
}

const SCALAR: ReadonlyMap<unknown, FieldKind> = new Map([
    ['number', 'number'],
    ['integer', 'number'],
    ['boolean', 'yesno'],
    ['object', 'group'],
]);

export function expectedKindFor(spec: unknown): FieldKind {
    if (!isObj(spec)) return 'unknown';
    const type = Array.isArray(spec.type) ? spec.type.find((x) => x !== 'null') || spec.type[0] : spec.type;
    if (type === 'string' || type === undefined) {
        const kind = stringKind(spec, type === 'string');
        if (kind) return kind;
    }
    if (type === 'array') return isObj(spec.items) && spec.items.type === 'object' ? 'table' : 'list';
    return SCALAR.get(type) ?? 'unknown';
}

export function outputFieldsOf(schema: OutputSchema | null | undefined): OutputField[] {
    const required = new Set(isObj(schema) && Array.isArray(schema.required) ? schema.required : []);
    return Object.entries(propsOf(schema))
        .filter(([key]) => key !== '')
        .map(([key, spec]) => ({
            key,
            kind: expectedKindFor(spec),
            unit: isObj(spec) && typeof spec['x-unit'] === 'string' ? spec['x-unit'] : '',
            description: isObj(spec) && typeof spec.description === 'string' ? spec.description : '',
            required: required.has(key),
        }));
}

function specFor(kind: EditableKind, description = ''): Spec {
    const base: Spec =
        kind === 'number' ? { type: 'number' }
        : kind === 'yesno' ? { type: 'boolean' }
        : kind === 'date' ? { type: 'string', format: 'date-time' }
        : { type: 'string' };
    return description ? { ...base, description } : base;
}

/** Rebuild the schema from ordered entries; no entries is `null`. */
function withProps(schema: OutputSchema | null | undefined, entries: [string, unknown][]): OutputSchema | null {
    if (entries.length === 0) return null;
    const keys = new Set(entries.map(([k]) => k));
    const required = isObj(schema) && Array.isArray(schema.required) ? schema.required.filter((k) => keys.has(k as string)) : [];
    const rest = isObj(schema) ? schema : {};
    const next: OutputSchema = { ...rest, type: 'object', properties: Object.fromEntries(entries) };
    if (required.length) next.required = required;
    else delete next.required;
    return next;
}

export function addOutputField(schema: OutputSchema | null | undefined, key: string, kind: EditableKind): OutputSchema | null {
    const name = key.trim();
    const entries = Object.entries(propsOf(schema));
    if (!FIELD_KEY.test(name) || entries.some(([k]) => k === name)) return schema ?? null;
    return withProps(schema, [...entries, [name, specFor(kind)]]);
}

export function removeOutputField(schema: OutputSchema | null | undefined, key: string): OutputSchema | null {
    return withProps(schema, Object.entries(propsOf(schema)).filter(([k]) => k !== key));
}

/** Switch one field to a scalar kind, keeping its description and its place. */
export function setOutputFieldKind(schema: OutputSchema | null | undefined, key: string, kind: EditableKind): OutputSchema | null {
    return withProps(
        schema,
        Object.entries(propsOf(schema)).map(([k, spec]) => {
            if (k !== key) return [k, spec];
            const description = isObj(spec) && typeof spec.description === 'string' ? spec.description : '';
            return [k, specFor(kind, description)];
        }),
    );
}
