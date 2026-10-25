// @typecheck noImplicitAny
// Read-only tools for the assistant. Run values never enter the model or the
// saved transcript before the PII detector has checked them. If the guard is
// absent/degraded, the assistant gets types and shapes instead of raw values.
const { canReadRunData } = require('../../../core/automationModel/callerRunVisibility');
const { fallback } = require('../../../utils/bestEffort');

const INSPECTION_NAMES = new Set(['builder_inspect_step', 'builder_inspect_mapping', 'builder_inspect_run']);
const INSPECTION_TOOLS = [...INSPECTION_NAMES].map(name => ({ type: 'function', function: {
    name,
    description: name === 'builder_inspect_step' ? 'Read one step and its settings. Does not change the flow.'
        : name === 'builder_inspect_mapping' ? 'Read this step\'s bindings and the schemas of its preceding steps. Never invent example values.'
            : 'Read the latest run\'s real inputs and outputs for a step, with personal data masked. If scanning is unavailable, only shapes and types are returned.',
    parameters: { type: 'object', additionalProperties: false, required: ['stepId'], properties: {
        stepId: { type: 'string' }, scope: { type: 'string', description: 'Optional flowlet key.' },
    } },
} }));

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function shapeOnly(value, depth = 0) {
    if (value == null) return null;
    if (depth > 6) return { type: typeof value };
    if (Array.isArray(value)) return { type: 'list', count: value.length, itemShape: value.length ? shapeOnly(value[0], depth + 1) : null };
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([_key, val], i) => [`field${i + 1}`, shapeOnly(val, depth + 1)]));
    return { type: typeof value, empty: value === '' };
}

/**
 * @typedef {Pick<typeof import('../../../core/privacy/piiDetection'), 'detectPii' | 'tokenizeText'>} InspectionPii
 */

/**
 * @param {unknown} values
 * @param {InspectionPii} pii
 */
async function maskedRunValues(values, { detectPii, tokenizeText }) {
    const encoded = JSON.stringify(values);
    if (encoded.length > 24000) return { values: shapeOnly(values), valuesAvailable: false, reason: 'Values exceed the inspection limit; shapes only.' };
    const scan = await detectPii(encoded).catch((e) => fallback('routes/ai/automationBuilder/inspectionTools:maskedRunValues', e, null));
    if (!scan || scan.degraded) return { values: shapeOnly(values), valuesAvailable: false, reason: 'PII scanning unavailable; shapes only.' };
    if (scan.hasPii && !scan.entities?.length) return { values: shapeOnly(values), valuesAvailable: false, reason: 'Personal data could not be masked; shapes only.' };
    // Offsets refer to the complete serialized tree, not an individual leaf.
    // Match the detector's text within each leaf instead, retaining token
    // continuity between every field in this inspection.
    const entities = (scan.entities || []).map((/** @type {import('../../../core/privacy/piiDetection/scanCache').PiiEntity & { start?: number, end?: number }} */ { offset, start, end, length, ...entity }) => entity);
    /** @type {Record<string, string>} */
    let tokenMap = {};
    /**
     * @param {unknown} value
     * @returns {unknown}
     */
    function redact(value) {
        if (typeof value === 'string' || typeof value === 'number') {
            const text = String(value);
            const masked = tokenizeText(text, entities, tokenMap);
            tokenMap = { ...tokenMap, ...masked.tokenMap };
            return typeof value === 'number' && masked.tokenizedText === text ? value : masked.tokenizedText;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [redact(key), redact(val)]));
        return value;
    }
    return { values: redact(values), valuesAvailable: true, personalDataMasked: true };
}

/**
 * @param {string} name
 * @param {{ stepId?: string, scope?: string }} args
 * @param {import('./turnSetup').BuilderDraftWrap} wrap
 * @param {{ store: typeof import('../../../stores/automationStore'), pii: InspectionPii }} deps
 */
async function inspect(name, args, wrap, { store, pii }) {
    const graph = args.scope ? wrap.def.layers?.[args.scope] : wrap.def;
    if (!graph) return { error: 'This flowlet does not exist.' };
    /** @typedef {import('../../../automation/builderTools/draftGraph').GraphStep | import('../../../automation/builderTools/draftGraph').GraphTrigger} AnyNode */
    const steps = /** @type {Array<AnyNode & { settings?: object, input?: unknown, inputs?: Record<string, unknown>, kind?: string, outputSchema?: unknown, responseSchema?: unknown, pinnedOutput?: unknown }>} */ (
        [graph.trigger, ...(graph.triggers || []), ...(graph.steps || [])].filter(Boolean));
    const at = steps.findIndex(s => s.id === args.stepId);
    if (at < 0) return { error: 'This step does not exist in the selected flow.' };
    const step = steps[at];
    if (name === 'builder_inspect_step') {
        const { pinnedOutput, ...configuration } = step;
        return { step: configuration, hasPinnedOutput: pinnedOutput != null };
    }
    if (name === 'builder_inspect_mapping') return {
        stepId: step.id, settings: step.settings || {}, input: step.input || step.inputs || null,
        sources: steps.slice(0, at).map(s => ({
            id: s.id, label: s.label || s.type || s.kind, type: s.type, outputSchema: s.outputSchema || s.responseSchema || null,
            // A code step's outputSchema describes what its code RETURNS, and
            // that sits under output.result (automation/codeOutput.js). Without
            // saying so the schema read as the step's output itself, and the
            // model bound steps.<code>.output.<field>, which is empty at run time.
            ...(s.type === 'code' ? { readAt: `steps.${s.id}.output.result` } : {}),
        })),
        hint: 'Read builder_inspect_run for real values. A schema is not proof a field has a value at runtime.',
    };
    if (!wrap.automationId) return { error: 'This automation has no saved runs yet.' };
    const automation = await store.getAutomation(wrap.automationId);
    if (!automation || automation.userId !== wrap.userId) return { error: 'Run inspection is only available to the owner.' };
    // The newest run whose data this person may read: a run on its starter's own
    // connections holds the starter's values, never the owner's builder's.
    const { runs } = await store.listRunsForAutomation(wrap.automationId, { limit: 10 });
    const run = (runs || []).find((r) => canReadRunData(r, wrap.userId));
    if (!run) return { error: 'This automation has no runs yet.' };
    const rows = await store.getRunSteps(run.id);
    // A flowlet's steps are recorded under the step that called it
    // (`<callStepId>/<stepId>`, execFlow.execCallLayer); a test of the
    // flowlet's own steps records them bare.
    const row = rows.find(r => r.stepId === args.stepId)
        || (args.scope ? rows.find(r => typeof r.stepId === 'string' && r.stepId.endsWith(`/${args.stepId}`)) : null);
    if (!row) return { error: 'This step did not run in the latest execution.' };
    return { stepId: args.stepId, runId: run.id, status: row.status,
        ...(await maskedRunValues({ input: row.input ?? null, output: row.output ?? null }, pii)) };
}

module.exports = { INSPECTION_NAMES, INSPECTION_TOOLS, inspect, shapeOnly, maskedRunValues };
