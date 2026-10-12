/**
 * Builder tools — tool inspection: the §B3 inspect-before-bind gate and
 * builder_inspect_tool (input params + output shape, runtime-cached when a
 * real run has taught us better). Required from within
 * automation/builderTools/ and the ../builderTools facade.
 */

const { compactSample } = require('./modelPayload');

/**
 * Reshape an OpenAI-format `parameters` block into the model-facing
 * `{inputs, requiredInputs}` view. Shared by builder_inspect_tool and the
 * inspect gate's schema-inlined rejection so the two can never drift.
 */
function renderInputsFromSchema(inSchema) {
    if (!inSchema || !inSchema.properties || typeof inSchema.properties !== 'object') {
        return { inputs: null, requiredInputs: [] };
    }
    const required = new Set(Array.isArray(inSchema.required) ? inSchema.required : []);
    const inputs = {};
    for (const [name, spec] of Object.entries(inSchema.properties)) {
        inputs[name] = {
            type: (spec && spec.type) || 'any',
            required: required.has(name),
            ...(spec && spec.description ? { description: String(spec.description).split('\n')[0] } : {}),
            ...(spec && Array.isArray(spec.enum) ? { enum: spec.enum.slice(0, 20) } : {}),
        };
    }
    return { inputs, requiredInputs: [...required] };
}

/**
 * §B3 inspect-before-bind gate. When the route has attached the per-turn
 * `_inputSchemasByTool` map and the agent hasn't seen `tool`'s schema this
 * session, block adding a non-trivial integration_action (≥1 required input,
 * or >1 total input) unless every required param is already bound.
 *
 * The rejection INLINES the full input schema (same shape builder_inspect_tool
 * returns) and marks the tool as inspected — the gate's purpose is "the model
 * must have seen the schema before binding", which the rejection itself now
 * fulfils. The retry therefore costs ONE round (resend the corrected add), not
 * two (inspect, then re-add). The escape hatch also marks the tool: a call
 * that bound every required param has demonstrably seen enough schema, and
 * leaving it unmarked made a later update/replace of the same tool re-gate.
 *
 * No-op when no catalog is attached (tests / older callers) or the tool has no
 * declared inputSchema.
 */
function inspectGateError(tool, rawInputs, draftWrap) {
    if (!tool || typeof tool !== 'string' || !draftWrap) return null;
    // Off where inspections cannot be remembered between calls (MCP, mcpBuilder.js).
    if (draftWrap._inspectGate === false) return null;
    const schemas = draftWrap._inputSchemasByTool;
    if (!schemas) return null;
    const schema = schemas[tool];
    if (!schema || !schema.properties) return null;        // unknown / declarationless tool → exempt
    const props = Object.keys(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const nonTrivial = required.length >= 1 || props.length > 1;
    if (!nonTrivial) return null;                          // trivial tool → stays one-shot
    const inspected = draftWrap._inspectedTools instanceof Set ? draftWrap._inspectedTools : null;
    if (inspected && inspected.has(tool)) return null;     // already inspected this session
    const bound = (rawInputs && typeof rawInputs === 'object') ? Object.keys(rawInputs) : [];
    if (required.length && required.every(r => bound.includes(r))) {
        if (inspected) inspected.add(tool);                // escape hatch — schema demonstrably known
        return null;
    }
    if (inspected) inspected.add(tool);                    // schema is in the rejection below
    const { inputs, requiredInputs } = renderInputsFromSchema(schema);
    let shape = null;
    let iterableFields = [];
    try {
        const { describeShape, iterableFieldsOf } = require('../outputSchemas');
        shape = describeShape(tool) || null;
        iterableFields = iterableFieldsOf(tool);
    } catch (_) { /* curated shape is best-effort */ }
    return {
        error: `"${tool}" was added without its input schema. The exact schema is inlined below — resend the SAME builder call now with the correct param names/bindings; do NOT call builder_inspect_tool for this tool.${required.length ? ` Required params: ${required.join(', ')}.` : ''}`,
        _needsInspect: tool,
        toolSchema: {
            inputs,
            requiredInputs,
            shape,
            ...(iterableFields.length ? { iterableFields } : {}),
        },
    };
}

/**
 * Inspect ONE tool: exact input params + output shape (+ sample unless
 * trimmed). Marks the tool as inspected for the §B3 gate.
 */
async function inspectOne(tool, draftWrap, { includeSample = true } = {}) {
    const shapeCache = require('../shapeCache');
    const { describeShape, getOutputSchema, iterableFieldsOf } = require('../outputSchemas');

    // A tool this user cannot run gets the SAME refusal the add gate gives, and
    // gets it BEFORE the mark below. Two reasons, both load-bearing.
    //
    // One: the shape data underneath comes from a static global table keyed on
    // tool name alone, so this function used to answer for `gmail_search` on an
    // org with no Gmail with a complete, confident schema — indistinguishable
    // from a connected tool, and read by the model as confirmation to proceed.
    //
    // Two: marking is what disarms the §B3 gate (see inspectGateError). Marking
    // a tool the user cannot use would downgrade the add-time refusal to a soft
    // one on the very next call. Only a successful inspect marks.
    const available = draftWrap && draftWrap._availableToolNames;
    if (available && !available.has(tool)) {
        const { unknownToolError } = require('./stepBuilders');
        const refusal = unknownToolError(tool, draftWrap);
        if (refusal) return { tool, ...refusal };
    }

    // §B3: record that the agent inspected this tool this session so the
    // add-action gate lets the subsequent builder_add_action through.
    if (draftWrap && draftWrap._inspectedTools instanceof Set) draftWrap._inspectedTools.add(tool);

    // §B2: INPUT params (names/types/required) from the per-turn catalog map the
    // route attaches — so the agent binds the exact param names without guessing.
    // The slim catalog only advertises an input COUNT; this is the on-demand detail.
    const inSchema = (draftWrap && draftWrap._inputSchemasByTool) ? draftWrap._inputSchemasByTool[tool] : null;
    const { inputs, requiredInputs } = renderInputsFromSchema(inSchema);

    // Prefer runtime-cached output shape (the source of truth from real runs).
    let shapeHint = null;
    let source = 'curated';
    try {
        const cached = await shapeCache.getShape({ userId: draftWrap.userId, toolName: tool });
        if (cached) {
            shapeHint = shapeCache.renderShapeHint(cached);
            source = 'runtime';
        }
    } catch (_) {}
    if (!shapeHint) {
        shapeHint = describeShape(tool);
    }
    if (!shapeHint) {
        return {
            tool,
            inputs,
            requiredInputs,
            shape: null,
            source: 'unknown',
            note: 'No declared output schema and no runtime sample. Run the tool once via dry-run / live to learn its shape, or just bind defensively.',
        };
    }
    const schema = getOutputSchema(tool);
    // `iterableFields` names the array outputs a per-step `forEach` can run over
    // (overRef = steps.<id>.output.<field>) — so the model picks the right one
    // on demand instead of from a bloated always-on prompt.
    const iterableFields = iterableFieldsOf(tool);
    // Sample diet: the curated sample is echoed for concreteness but bounded
    // (arrays → 1 item, strings capped); when even the compacted form is
    // large — or on a multi-tool inspect — it is dropped in favour of the
    // one-line `shape`, which is the authoritative binding signal anyway.
    const rawSample = schema?.sample ?? null;
    const sample = includeSample ? compactSample(rawSample) : null;
    return {
        tool,
        inputs,
        requiredInputs,
        shape: shapeHint,
        source,
        sample,
        ...(includeSample && rawSample != null && sample === null
            ? { note: 'sample omitted (large); the shape line above is authoritative' } : {}),
        ...(iterableFields.length ? { iterableFields } : {}),
    };
}

async function applyInspectTool(args, draftWrap) {
    // Batch form: tools:[...] inspects up to 8 tools in ONE call (samples
    // omitted — inputs/shape are the load-bearing fields). Single-tool form
    // keeps the original result shape for saved histories and small models.
    const list = Array.isArray(args?.tools)
        ? args.tools.filter(t => typeof t === 'string' && t.trim()).slice(0, 8)
        : null;
    if (list && list.length) {
        const inspected = await Promise.all(list.map(t => inspectOne(t, draftWrap, { includeSample: false })));
        const results = {};
        for (const r of inspected) results[r.tool] = r;
        return { results };
    }
    const tool = args && typeof args.tool === 'string' ? args.tool : null;
    if (!tool) return { error: 'tool name required — pass {tool:"name"} or {tools:["a","b",…]}' };
    return inspectOne(tool, draftWrap, { includeSample: true });
}

module.exports = {
    inspectGateError,
    applyInspectTool,
};
