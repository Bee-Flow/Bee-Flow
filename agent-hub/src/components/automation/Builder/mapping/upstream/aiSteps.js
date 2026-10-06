/**
 * The two steps whose output shape the AUTHOR declares rather than the
 * catalog: an AI step with an `outputSchema`, and an Extract-data step whose
 * declared field names ARE its output. Both are bindable the moment the
 * declaration exists — no run, no schema round-trip.
 */
import { sampleToFields, samplePlaceholderFor, schemaToSample } from './sampleFields';

export function describeAiStep(node) {
    // When the user (or AI builder) declared an outputSchema, surface its
    // fields so downstream steps can bind to them directly. We accept both
    // JSON Schema shape and the flat `{field:'type'}` shape — same tolerance
    // as the runtime in server/core/automationRunner.js.
    //
    // WITHOUT a schema the runtime returns the RAW RESPONSE STRING as the
    // whole output — the old `{text, toolCalls}` promise here was pure
    // fiction (neither key has ever existed at run time; every binding built
    // from it resolved undefined — C21). One honest leaf: bind the whole
    // output.
    const props = aiStepOutputProps(node.outputSchema);
    if (!props) {
        return {
            id: node.id,
            label: node.label || 'AI step',
            kind: 'ai_step',
            basePath: `steps.${node.id}.output`,
            sample: '<AI response>',
            fields: [{ key: 'response', path: `steps.${node.id}.output`, sample: '<AI response>' }],
        };
    }
    // A nested declaration is a nested sample, so `customer.address.city` and
    // `items[*].sku` are pickable before the step has ever run.
    const sample = Object.fromEntries(Object.entries(props).map(([k, t]) => [k, schemaToSample(t)]));
    return {
        id: node.id,
        label: node.label || 'AI step',
        kind: 'ai_step',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

/**
 * data_extraction output = ONE flat object with exactly the declared field
 * names (the runtime contract — see server execDataExtraction: a field the
 * model could not find is null, never a missing key, never `_raw`). The
 * step's `fields` therefore ARE its output shape, which is what lets a
 * downstream step drag `steps.<id>.output.datum` off the tree the moment the
 * author has typed a name — no schema, no run needed. Typed placeholders so
 * the kind badges and the mismatch box know a date from an amount.
 */
export function describeDataExtraction(node) {
    const declared = (Array.isArray(node.fields) ? node.fields : [])
        .filter(f => f && typeof f.name === 'string' && f.name.trim());
    const sample = {};
    for (const f of declared) {
        if (f.name in sample) continue;
        sample[f.name] = extractionPlaceholderFor(f.type);
    }
    return {
        id: node.id,
        label: node.label || 'Extract data',
        kind: 'data_extraction',
        basePath: `steps.${node.id}.output`,
        sample,
        fields: sampleToFields(sample, `steps.${node.id}.output`),
    };
}

function extractionPlaceholderFor(type) {
    // `date` is an ISO YYYY-MM-DD string on the wire; a real-looking one lets
    // fieldKinds read it as a date rather than as free text.
    if (type === 'date') return '2026-01-15';
    return samplePlaceholderFor(type);
}

/** The declared top-level properties, each as its own (sub)schema; null when none. */
function aiStepOutputProps(schema) {
    if (!schema || typeof schema !== 'object') return null;
    const raw = schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : schema;
    const out = {};
    for (const [k, v] of Object.entries(raw || {})) {
        if (!k) continue;
        if (typeof v === 'string' || (v && typeof v === 'object')) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}
