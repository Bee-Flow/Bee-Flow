/**
 * An AI step's structured output: the editor's field rows ↔ the JSON Schema
 * stored on the step. Both runtime shapes are read (JSON Schema and flat
 * `{name: 'type'}`); JSON Schema is always written. Nested object properties
 * and scalar-item arrays ride along opaquely (C13), so extract → rebuild is the
 * identity. From agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { isObj } from '../bindings/json';

export const OUTPUT_FIELD_TYPES: readonly string[] = ['string', 'number', 'boolean', 'datetime', 'object', 'array'];
/** Column types for a table (array-of-objects) field — flat scalars only. */
export const COLUMN_TYPES: readonly string[] = ['string', 'number', 'boolean', 'datetime'];

export interface OutputField {
    key: string;
    type: string;
    description: string;
    required?: boolean;
    columns?: { key: string; type: string }[];
    itemsSpec?: Record<string, unknown>;
    objectSpec?: Record<string, unknown>;
    objectRequired?: unknown[];
}

// `datetime` is a string with an ISO 8601 date-time format on the wire.
function scalarSpec(type: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (type === 'datetime') return { type: 'string', format: 'date-time' };
    return { type: allowed.includes(type as string) ? type : 'string' };
}

function scalarType(spec: unknown, allowed: readonly string[]): string {
    const s = isObj(spec) ? spec : null;
    if (s && s.type === 'string' && (s.format === 'date-time' || s.format === 'date')) return 'datetime';
    return allowed.includes(s?.type as string) ? (s?.type as string) : 'string';
}

function tableColumns(itemProps: Record<string, unknown>): { key: string; type: string }[] {
    return Object.entries(itemProps)
        .filter(([ck]) => ck)
        .map(([ck, cs]) => ({ key: ck, type: scalarType(cs, COLUMN_TYPES) }));
}

function fieldFromSpec(key: string, spec: Record<string, unknown>, required: boolean): OutputField {
    const field: OutputField = {
        key,
        type: scalarType(spec, OUTPUT_FIELD_TYPES),
        description: typeof spec.description === 'string' ? spec.description : '',
    };
    if (required) field.required = true;
    const items = spec.items && typeof spec.items === 'object' ? (spec.items as Record<string, unknown>) : null;
    const itemProps = items ? items.properties : null;
    if (field.type === 'array' && itemProps && typeof itemProps === 'object') field.columns = tableColumns(itemProps as Record<string, unknown>);
    else if (field.type === 'array' && items) field.itemsSpec = items;
    if (field.type === 'object' && spec.properties && typeof spec.properties === 'object') {
        field.objectSpec = spec.properties as Record<string, unknown>;
        if (Array.isArray(spec.required)) field.objectRequired = spec.required;
    }
    return field;
}

export function schemaToFields(schema: unknown): OutputField[] {
    if (!schema || typeof schema !== 'object') return [];
    const s = schema as Record<string, unknown>;
    const props = s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : s;
    const requiredKeys = new Set(Array.isArray(s.required) ? s.required : []);
    const out: OutputField[] = [];
    for (const [key, spec] of Object.entries(props || {})) {
        if (!key) continue;
        if (typeof spec === 'string') {
            out.push({ key, type: OUTPUT_FIELD_TYPES.includes(spec) ? spec : 'string', description: '' });
        } else if (spec && typeof spec === 'object') {
            out.push(fieldFromSpec(key, spec as Record<string, unknown>, requiredKeys.has(key)));
        }
    }
    return out;
}

function columnProps(columns: unknown[]): Record<string, unknown> {
    const colProps: Record<string, unknown> = {};
    for (const c of columns) {
        if (!isObj(c) || typeof c.key !== 'string' || !c.key.trim()) continue;
        colProps[c.key.trim()] = scalarSpec(c.type, COLUMN_TYPES);
    }
    return colProps;
}

function specFor(f: Record<string, unknown>): Record<string, unknown> {
    const spec = scalarSpec(f.type, OUTPUT_FIELD_TYPES);
    if (typeof f.description === 'string' && f.description.trim()) spec.description = f.description.trim();
    if (f.type === 'array' && Array.isArray(f.columns)) {
        const colProps = columnProps(f.columns);
        if (Object.keys(colProps).length) spec.items = { type: 'object', properties: colProps };
    } else if (f.type === 'array' && f.itemsSpec && typeof f.itemsSpec === 'object') {
        spec.items = f.itemsSpec;
    }
    if (f.type === 'object' && f.objectSpec && typeof f.objectSpec === 'object') {
        spec.properties = f.objectSpec;
        if (Array.isArray(f.objectRequired) && f.objectRequired.length) spec.required = f.objectRequired;
    }
    return spec;
}

export function fieldsToSchema(fields: unknown): Record<string, unknown> | null {
    const valid = ((fields as unknown[]) || []).filter(
        (f): f is Record<string, unknown> => isObj(f) && typeof f.key === 'string' && !!f.key.trim(),
    );
    if (valid.length === 0) return null;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const f of valid) {
        const key = (f.key as string).trim();
        if (f.required) required.push(key);
        properties[key] = specFor(f);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
