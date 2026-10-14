// ── AI step structured-output helpers ──────────────────────────────────
//
// We support two shapes the runtime accepts (server/core/automationRunner.js
// stringifies `effectiveSchema` verbatim and tells the model "match this"):
//   1. JSON Schema:   { type:'object', properties:{ name:{type:'string'} } }
//   2. Flat:          { name:'string' }
// On read we accept both; on write we always emit shape #1 so the AI builder
// and templates (templates.js uses JSON Schema) round-trip cleanly.

import type { FormRecord, JsonValue } from './types';

export const OUTPUT_FIELD_TYPES = ['string', 'number', 'boolean', 'datetime', 'object', 'array'];
// Column types for a table (array-of-objects) field — flat scalars only.
export const COLUMN_TYPES = ['string', 'number', 'boolean', 'datetime'];

// `datetime` isn't a native JSON-schema type — it's a string with an ISO 8601
// date-time format, which is what we tell the model to emit. These two helpers
// translate between our friendly type names and the schema fragment so the
// round-trip (save → schema → reload) stays lossless.
function scalarSpec(type: JsonValue, allowed: string[]): FormRecord {
    if (type === 'datetime') return { type: 'string', format: 'date-time' };
    return { type: allowed.includes(type) ? type : 'string' };
}
function scalarType(spec: JsonValue, allowed: string[]): string {
    if (spec && spec.type === 'string' && (spec.format === 'date-time' || spec.format === 'date')) return 'datetime';
    return allowed.includes(spec?.type) ? spec.type : 'string';
}

export function schemaToFields(schema: JsonValue): FormRecord[] {
    if (!schema || typeof schema !== 'object') return [];
    const props: FormRecord = schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : schema;
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
    const out: FormRecord[] = [];
    for (const [key, spec] of Object.entries(props || {})) {
        if (!key) continue;
        if (typeof spec === 'string') {
            out.push({ key, type: OUTPUT_FIELD_TYPES.includes(spec) ? spec : 'string', description: '' });
        } else if (spec && typeof spec === 'object') {
            const field: FormRecord = {
                key,
                type: scalarType(spec, OUTPUT_FIELD_TYPES),
                description: typeof spec.description === 'string' ? spec.description : '',
            };
            if (requiredKeys.has(key)) field.required = true;
            // Table columns: an array whose items are an object with properties.
            // Object.entries preserves insertion order, so column order survives.
            const itemProps = spec.items && typeof spec.items === 'object' ? spec.items.properties : null;
            if (field.type === 'array' && itemProps && typeof itemProps === 'object') {
                field.columns = Object.entries(itemProps)
                    .filter(([ck]) => ck)
                    .map(([ck, cs]) => ({ key: ck, type: scalarType(cs, COLUMN_TYPES) }));
            } else if (field.type === 'array' && spec.items && typeof spec.items === 'object') {
                // Scalar-item arrays (e.g. {type:'array', items:{type:'string'}}):
                // stash the items spec verbatim so the save round-trip doesn't
                // discard it (C13 — every save used to degrade these to an
                // untyped array).
                field.itemsSpec = spec.items;
            }
            // Nested object properties ride along OPAQUELY: the form can't
            // edit them (yet), but extract→rebuild must be the identity, not
            // a lossy downgrade to a bare {type:'object'} (C13).
            if (field.type === 'object' && spec.properties && typeof spec.properties === 'object') {
                field.objectSpec = spec.properties;
                if (Array.isArray(spec.required)) field.objectRequired = spec.required;
            }
            out.push(field);
        }
    }
    return out;
}

export function fieldsToSchema(fields: FormRecord[] | null | undefined): FormRecord | null {
    const valid = (fields || []).filter(f => f && typeof f.key === 'string' && f.key.trim());
    if (valid.length === 0) return null;
    const properties: FormRecord = {};
    const required: string[] = [];
    for (const f of valid) {
        const spec = scalarSpec(f.type, OUTPUT_FIELD_TYPES);
        if (f.description && f.description.trim()) spec.description = f.description.trim();
        // A table (array) with declared columns → array of objects with those
        // typed properties IN THE DECLARED ORDER, so the model returns rows the
        // Output panel renders as a real table with those headers in that order.
        // Empty/unnamed columns are skipped; if none remain the array stays
        // untyped (model infers the columns).
        if (f.type === 'array' && Array.isArray(f.columns)) {
            const colProps: FormRecord = {};
            for (const c of f.columns) {
                if (!c || typeof c.key !== 'string' || !c.key.trim()) continue;
                colProps[c.key.trim()] = scalarSpec(c.type, COLUMN_TYPES);
            }
            if (Object.keys(colProps).length) spec.items = { type: 'object', properties: colProps };
        } else if (f.type === 'array' && f.itemsSpec && typeof f.itemsSpec === 'object') {
            spec.items = f.itemsSpec; // opaque passthrough (C13)
        }
        if (f.type === 'object' && f.objectSpec && typeof f.objectSpec === 'object') {
            spec.properties = f.objectSpec; // opaque passthrough (C13)
            if (Array.isArray(f.objectRequired) && f.objectRequired.length) spec.required = f.objectRequired;
        }
        if (f.required) required.push(f.key.trim());
        properties[f.key.trim()] = spec;
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
