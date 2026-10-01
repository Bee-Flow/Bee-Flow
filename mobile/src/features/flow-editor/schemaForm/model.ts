/**
 * The model behind the schema-driven inputs form — the pure half of agent-hub
 * `Builder/mapping/ToolInputForm.jsx`, the one web editor that is driven by a
 * schema (a tool's catalog `inputSchema`).
 *
 * Two modes, as on the web:
 *   schema  — `inputSchema.properties` known: essential fields show, the rest
 *             sit behind "Show N more options" (bindings/partitionInputs), and
 *             inputs the schema doesn't declare are listed as extras;
 *   generic — no schema (custom tools, AI step inputs): key/value rows.
 * Both edit the same `{ [key]: binding }` map the runtime resolves.
 *
 * The row edits (update, rename, add, the pending rows, the name commit) live
 * in rows.ts. Pinned by schemaForm.lockstep.test.ts, which evaluates the web
 * component's own helper source beside these.
 */

import { translate as t } from '@/core/i18n';
import { slotShape, type Slot } from '@/shared/mapping';

import { type FieldKind, expectedKindFor } from '../bindings/fieldKinds';
import { partitionInputs } from '../bindings/partitionInputs';
import type { BindingValue, JsonSchema, JsonSchemaProp } from '../bindings/types';

export interface SchemaFormField {
    key: string;
    label: string;
    hint: string | null;
    required: boolean;
    placeholder: string;
    multiline: boolean;
    /** What the field wants of a picked value (the core's slotShape of its schema). */
    slot: Slot;
    /** The parameter's own schema, for the value field (BindingInput `schema`). */
    schema: JsonSchemaProp;
    expectKind: FieldKind;
    /** A declared option list — the phone offers it as a picker. */
    options: unknown[] | null;
    value: BindingValue | null;
    autoMapped: boolean;
}

export interface GenericRow {
    key: string;
    value: BindingValue;
    siblingKeys: string[];
    autoMapped: boolean;
}

export interface SchemaFormModel {
    mode: 'schema' | 'generic';
    essential: SchemaFormField[];
    advanced: SchemaFormField[];
    /** How many advanced fields auto-map filled (the disclosure's "N auto" badge). */
    advancedAutoCount: number;
    /** Schema mode: inputs the schema doesn't declare. Generic mode: every row. */
    rows: GenericRow[];
}

/** An example for the empty field, from the schema's own hints. */
export function describeExample(prop: JsonSchemaProp | null | undefined): string {
    if (!prop) return '';
    if (prop.example != null) return String(prop.example);
    if (prop.default != null) return String(prop.default);
    if (prop.enum && prop.enum.length) {
        const more = prop.enum.length > 3 ? '…' : '';
        return t('mobile.flow.input.one_of', 'one of: {options}', { options: `${prop.enum.slice(0, 3).join(', ')}${more}` });
    }
    return typeExample(prop.type);
}

function typeExample(type: unknown): string {
    if (type === 'number' || type === 'integer') return t('mobile.flow.input.example_number', 'e.g. 42');
    if (type === 'boolean') return t('mobile.flow.input.example_boolean', 'true / false');
    if (type === 'array') return '[…]';
    if (type === 'object') return '{…}';
    return '';
}

/** A multi-line box: a declared multiline format, or a body/message/prompt-like name. */
export function isMultilineProp(prop: JsonSchemaProp | null | undefined): boolean {
    if (!prop) return false;
    if (prop.format === 'multiline' || prop.format === 'textarea') return true;
    const name = String(prop.title || '').toLowerCase();
    return /body|message|prompt|content|description|notes/.test(name);
}

export interface ModelInput {
    inputSchema?: JsonSchema | null;
    /** The step's `inputs` as stored; each value is read as a binding. */
    inputs?: Readonly<Record<string, unknown>> | null;
    /** Keys auto-map filled (the "auto" pill)… */
    autoMappedKeys?: readonly string[];
    /** …minus the ones the user has since edited. */
    consumedKeys?: ReadonlySet<string>;
}

function fieldFor(key: string, prop: JsonSchemaProp, ctx: { required: Set<string>; inputs: Record<string, BindingValue>; isAuto: (k: string) => boolean }): SchemaFormField {
    return {
        key,
        label: prop.title || key,
        hint: prop.description || null,
        required: ctx.required.has(key),
        placeholder: describeExample(prop),
        multiline: isMultilineProp(prop),
        slot: slotShape(prop, { field: key }),
        schema: prop,
        expectKind: expectedKindFor(prop),
        options: Array.isArray(prop.enum) && prop.enum.length ? prop.enum : null,
        value: ctx.inputs[key] ?? null,
        autoMapped: ctx.isAuto(key),
    };
}

/**
 * A row's siblings are EVERY other key of the map, schema keys included: the
 * web passes none for schema-mode extras, so renaming one onto a declared
 * parameter silently merged the two. The one deliberate difference.
 */
function rowsFor(keys: string[], inputs: Record<string, BindingValue>, isAuto: (k: string) => boolean): GenericRow[] {
    const all = Object.keys(inputs);
    return keys.map((key) => ({ key, value: inputs[key], siblingKeys: all.filter((k) => k !== key), autoMapped: isAuto(key) }));
}

/** The whole form, ready to render. */
export function buildSchemaFormModel({ inputSchema = null, inputs = {}, autoMappedKeys = [], consumedKeys = new Set() }: ModelInput): SchemaFormModel {
    const values = (inputs || {}) as Record<string, BindingValue>;
    const isAuto = (key: string) => autoMappedKeys.includes(key) && !consumedKeys.has(key);
    const properties = inputSchema?.properties || null;
    if (!properties) {
        return { mode: 'generic', essential: [], advanced: [], advancedAutoCount: 0, rows: rowsFor(Object.keys(values), values, isAuto) };
    }
    const required = new Set(inputSchema?.required || []);
    const { essentialKeys, advancedKeys } = partitionInputs(properties, required, values);
    const ctx = { required, inputs: values, isAuto };
    const known = new Set(Object.keys(properties));
    return {
        mode: 'schema',
        essential: essentialKeys.map((k) => fieldFor(k, properties[k] || {}, ctx)),
        advanced: advancedKeys.map((k) => fieldFor(k, properties[k] || {}, ctx)),
        advancedAutoCount: advancedKeys.filter(isAuto).length,
        rows: rowsFor(Object.keys(values).filter((k) => !known.has(k)), values, isAuto),
    };
}
