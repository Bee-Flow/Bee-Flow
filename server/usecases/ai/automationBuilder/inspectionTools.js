// @typecheck strict
// Read-only tools for the assistant. Run values never enter the model or the
// saved transcript before the PII detector has checked them. If the guard is
// absent/degraded, the assistant gets types and shapes instead of raw values.
const { canReadRunData } = require('../../../auth/callerRunVisibility');
const { fallback } = require('../../../utils/bestEffort');

const INSPECTION_NAMES = new Set(['builder_inspect_step', 'builder_inspect_mapping', 'builder_inspect_run']);
const INSPECTION_TOOLS = [...INSPECTION_NAMES].map(name => ({ type: 'function', function: {
    name,
    description: name === 'builder_inspect_step' ? 'Read one step and its settings. Does not change the flow.'
        : name === 'builder_inspect_mapping' ? 'Read this step\'s bindings and the schemas of its preceding steps. Never invent example values.'
            : 'Read the latest run\'s real inputs and outputs for a step, with personal data masked, which run it is (mode, test or dry run) and the ready-to-bind `paths` of every list in the output. Large outputs come back shortened (lists cut, keys kept). If scanning is unavailable, only keys and types are returned.',
    parameters: { type: 'object', additionalProperties: false, required: ['stepId'], properties: {
        stepId: { type: 'string' }, scope: { type: 'string', description: 'Optional flowlet key.' },
    } },
} }));

const MAX_INSPECTED_CHARS = 24000;

/**
 * No values at all: the keys and types of the value in the path grammar the
 * bindings use (`results[*]: item: {...}; output: {...}`). Same policy as the
 * dry run's hint (builderTools dryRunHint): key names go to the model, values
 * never do.
 * @param {unknown} values
 * @param {string} reason
 */
function shapesOnly(values, reason) {
    return { values: require('../../../automation/shapeCache').shapeHintOf(values), valuesAvailable: false, reason };
}

/**
 * @typedef {Pick<typeof import('../../../core/privacy/piiDetection'), 'detectPii' | 'tokenizeText'>} InspectionPii
 */

/**
 * @param {unknown} values
 * @param {InspectionPii} pii
 */
async function maskedRunValues(values, { detectPii, tokenizeText }) {
    // Over the limit: keep the keys and cut the lists and long text
    // (payloadTruncation.shapePreview) instead of renaming every key, because
    // the key names ARE the paths the model has to bind. The cut copy goes
    // through the same scan below, keys included (redact masks keys too).
    let shown = values;
    /** @type {{ previewCut?: Record<string, number>, note?: string }} */
    let cut = {};
    if (JSON.stringify(values).length > MAX_INSPECTED_CHARS) {
        const preview = require('../../../stores/automationStore/payloadTruncation').shapePreview(values, { maxBytes: 20000 });
        if (!preview) return shapesOnly(values, 'Values exceed the inspection limit; keys and types only.');
        shown = preview.preview;
        cut = { previewCut: preview.previewCut, note: 'Lists shortened and long text cut to fit the inspection limit; the keys are complete up to previewCut.' };
    }
    const scan = await detectPii(JSON.stringify(shown)).catch((e) => fallback('usecases/ai/automationBuilder/inspectionTools:maskedRunValues', e, null));
    if (!scan || scan.degraded) return shapesOnly(values, 'PII scanning unavailable; keys and types only.');
    if (scan.hasPii && !scan.entities?.length) return shapesOnly(values, 'Personal data could not be masked; keys and types only.');
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
    // previewCut's paths are built from the same keys, so they are masked too.
    const maskedValues = redact(shown);
    const cutShown = cut.previewCut ? { previewCut: /** @type {Record<string, number>} */ (redact(cut.previewCut)), note: cut.note } : {};
    return { values: maskedValues, valuesAvailable: true, personalDataMasked: true, ...cutShown };
}

/**
 * @param {string} name
 * @param {{ stepId?: string, scope?: string }} args
 * @param {import('../../../routes/ai/automationBuilder/turnSetup').BuilderDraftWrap} wrap
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
    // Mapped from rows one to one, so no entry is null.
    const rows = /** @type {Array<NonNullable<Awaited<ReturnType<typeof store.getRunSteps>>[number]>>} */ (await store.getRunSteps(run.id));
    // A flowlet's steps are recorded under the step that called it
    // (`<callStepId>/<stepId>`, execFlow.execCallLayer); a test of the
    // flowlet's own steps records them bare.
    const row = rows.find(r => r.stepId === args.stepId)
        || (args.scope ? rows.find(r => typeof r.stepId === 'string' && r.stepId.endsWith(`/${args.stepId}`)) : null);
    if (!row) return { error: 'This step did not run in the latest execution.' };
    const stored = await require('../../../automation/builderTools').resolveStoredOutput(row.output ?? null);
    const masked = await maskedRunValues({ input: row.input ?? null, output: stored.out ?? null }, pii);
    const rootPath = graph.trigger?.id === args.stepId || (graph.triggers || []).some(t => t.id === args.stepId) ? 'trigger.output' : `steps.${args.stepId}.output`;
    const shownOutput = masked.valuesAvailable && masked.values && typeof masked.values === 'object' ? /** @type {{ output?: unknown }} */ (masked.values).output : undefined;
    return { stepId: args.stepId, runId: run.id, status: row.status,
        run: runContext(run),
        ...(isSynthesised(stored.out) ? { synthesised: true } : {}),
        ...(stored.note ? { outputNote: stored.note } : {}),
        ...masked,
        ...(shownOutput !== undefined ? { paths: listPaths(shownOutput, rootPath) } : {}) };
}

/**
 * Which run these values come from: a test or dry run holds other data than a
 * live one, so the model has to be able to tell them apart.
 * @param {{ id: string, mode?: string | null, isTest?: boolean, startedAt?: string | null, status?: string | null }} run
 */
function runContext(run) {
    return { id: run.id, mode: run.mode ?? null, isTest: !!run.isTest, startedAt: run.startedAt ?? null, status: run.status ?? null };
}

/**
 * A dry run stamps an output it made up rather than read (datatableWrites,
 * execDocument write both spellings).
 * @param {unknown} output
 */
function isSynthesised(output) {
    return !!output && typeof output === 'object' && !Array.isArray(output)
        && (/** @type {Record<string, unknown>} */ (output)._dryRunSynthesised === true || /** @type {Record<string, unknown>} */ (output).dryRunSynthesised === true);
}

const MAX_PATHS = 40;
const MAX_PATH_DEPTH = 6;

/**
 * The lists in a step's output and their fields, each written the way a
 * binding reads them: `steps.s1.output.results[*].output.items[*].title`. A
 * fixed index (`results[0]`) reads one iteration only; `[*]` flattens them all.
 * Built from the already masked values, so a key is never shown that the
 * inspection would not show.
 * @param {unknown} output
 * @param {string} base
 * @returns {string[]}
 */
function listPaths(output, base) {
    const { appendKey } = require('../../../automation/expr');
    /** @type {string[]} */
    const found = [];
    /**
     * @param {unknown} value
     * @param {string} path
     * @param {number} depth
     * @param {boolean} inList
     */
    const walk = (value, path, depth, inList) => {
        if (found.length >= MAX_PATHS || depth > MAX_PATH_DEPTH || value === null || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            found.push(path);
            const first = value.find(v => v !== null && typeof v === 'object');
            if (first) walk(first, `${path}[*]`, depth + 1, true);
            return;
        }
        for (const [key, val] of Object.entries(value)) {
            const next = appendKey(path, key);
            if (val !== null && typeof val === 'object') walk(val, next, depth + 1, inList);
            else if (inList && found.length < MAX_PATHS) found.push(next);
        }
    };
    walk(output, base, 0, false);
    return [...new Set(found)];
}

module.exports = { INSPECTION_NAMES, INSPECTION_TOOLS, inspect, maskedRunValues };
