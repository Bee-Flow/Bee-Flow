/**
 * Auto-map ONE step against its upstream context, per step type — and apply
 * that to a definition, marking the filled keys `autoMapped` so the editor can
 * show the "auto" pill. From agent-hub `Builder/mapping/autoMapInputs.js`
 * (autoMapStep / applyAutoMapToStep); pinned by autoMap.lockstep.test.ts.
 */

import { autoMapInputs, findInputSchemaForTool, nearestArrayRef, nearestScannableRef, rankedArrayRefs } from './autoMap';
import { tryIterationMapping } from './autoMapIteration';
import { getLayerContract } from './flowDeps/flowletScope';
import { buildSampleRoot } from './realOutputs';
import type { Catalog, FlowDefinition, FlowNode, ForEach, JsonSchema, VariableGroup } from './types';
import { computeUpstreamGroups } from './upstream';
import { isDiagnosticOutputKey } from './upstream/stepPayload';
import { flattenLevels, flattenRouteFields } from '../model/flattenStep';
import { reconcileRouteEdges } from '../model/route/routeEdges';

export interface AutoMapOptions {
    maxPerStep?: number;
    realOutputById?: Map<string, unknown> | null;
}

export interface AutoMapResult {
    step: FlowNode;
    mappedKeys: string[];
    forEachEnabled?: boolean;
}

const LIST_OPS = new Set(['filter', 'limit', 'dedupe', 'aggregate', 'summarize', 'flatten']);

/** The palette scaffold (never user-chosen); the legacy literal heals on re-connect (C20). */
function isScaffoldOverRef(ref: unknown): boolean {
    return !ref || ref === 'trigger.output.items';
}

/** The untouched condition scaffold: '' or the seeded 'true'. */
function isScaffoldExpr(expr: unknown): boolean {
    const src = String(expr || '').trim();
    return src === '' || src === 'true';
}

const unchanged = (step: FlowNode): AutoMapResult => ({ step, mappedKeys: [] });

function withInputs(step: FlowNode, patch: Record<string, unknown>, slot: 'inputs' | 'fields' = 'inputs'): AutoMapResult {
    const keys = Object.keys(patch);
    if (!keys.length) return unchanged(step);
    return { step: { ...step, [slot]: { ...((step[slot] as object) || {}), ...patch } }, mappedKeys: keys };
}

/** Bind `key` to the nearest upstream array, or leave the step alone. */
function withArrayRef(step: FlowNode, groups: VariableGroup[], key: 'arrayRef' | 'overRef', extra: Partial<FlowNode> = {}): AutoMapResult {
    const ref = nearestArrayRef(groups);
    return ref ? { step: { ...step, ...extra, [key]: ref }, mappedKeys: [key] } : unchanged(step);
}

/** What every per-type mapper reads besides the step itself. */
interface MapContext {
    definition: FlowDefinition;
    catalog: Catalog | null | undefined;
    groups: VariableGroup[];
    opts: AutoMapOptions;
}

function mapIntegration(step: FlowNode, { definition, catalog, groups, opts }: MapContext): AutoMapResult {
    const schema = findInputSchemaForTool(catalog, step.tool);
    // Iteration fallback — never over a forEach the user set. Decided on the
    // inputs WITHOUT list columns: a step that runs once per row never also
    // gets every row's value, so the columns come only when it runs once.
    const inputs = step.inputs || {};
    const single = autoMapInputs(schema, inputs, groups, { ...opts, listColumns: false });
    const iter = step.forEach ? null : tryIterationMapping(schema, { ...inputs, ...single }, groups, { isDiagnostic: isDiagnosticOutputKey, definition });
    const patch = iter ? single : autoMapInputs(schema, inputs, groups, opts);
    let nextInputs: Record<string, unknown> = { ...inputs, ...patch };
    let keys = Object.keys(patch);
    let forEach: ForEach | null = null;
    if (iter) {
        nextInputs = { ...nextInputs, ...iter.patch };
        keys = [...keys, ...Object.keys(iter.patch)];
        forEach = iter.forEach;
    }
    if (!keys.length && !forEach) return unchanged(step);
    const nextStep: FlowNode = { ...step, inputs: nextInputs as FlowNode['inputs'] };
    if (forEach) nextStep.forEach = forEach;
    return { step: nextStep, mappedKeys: keys, forEachEnabled: !!forEach };
}

/** A flowlet call's pseudo-schema: its declared params, or its existing keys. */
function layerParamSchema(step: FlowNode, definition: FlowDefinition): JsonSchema {
    const { params } = getLayerContract(definition, step.layerKey);
    if (params.length) {
        return {
            properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type }])),
            required: params.filter((p) => p.required).map((p) => p.name),
        };
    }
    return { properties: Object.fromEntries(Object.keys(step.inputs || {}).map((k) => [k, {}])), required: [] };
}

function mapPrivacy(step: FlowNode, groups: VariableGroup[]): AutoMapResult {
    if (typeof step.sourceRef === 'string' && step.sourceRef.trim()) return unchanged(step);
    const ref = nearestScannableRef(groups);
    return ref ? { step: { ...step, sourceRef: ref }, mappedKeys: ['sourceRef'] } : unchanged(step);
}

/** A PRISTINE Edit-data below a list becomes list mode; a blank list source binds. */
function mapSet(step: FlowNode, groups: VariableGroup[], opts: AutoMapOptions): AutoMapResult {
    const pristine = !Object.keys((step.fields as object) || {}).length
        && !step.forEach
        && typeof step.arrayRef !== 'string'
        && !(Array.isArray(step.operations) && step.operations.length);
    const listSource = pristine || (typeof step.arrayRef === 'string' && isScaffoldOverRef(step.arrayRef));
    if (listSource && nearestArrayRef(groups)) return withArrayRef(step, groups, 'arrayRef');
    return withInputs(step, autoMapInputs(null, (step.fields as Record<string, unknown>) || {}, groups, opts), 'fields');
}

/**
 * Flatten a list (F45): the first upstream list, nearest first, whose items
 * hold a list of records; its first such list is the level, and the plan is
 * made from the sample. No such list leaves the step blank.
 */
function mapFlatten(step: FlowNode, groups: VariableGroup[]): AutoMapResult {
    if (!isScaffoldOverRef(step.arrayRef)) return unchanged(step);
    const root = buildSampleRoot(groups);
    for (const source of rankedArrayRefs(groups)) {
        const level = flattenLevels(source, root)[0];
        const fields = level ? flattenRouteFields(step, level.path, root) : null;
        if (fields) return { step: { ...step, ...fields } as FlowNode, mappedKeys: ['arrayRef'] };
    }
    return unchanged(step);
}

type Mapper = (step: FlowNode, ctx: MapContext) => AutoMapResult;

const privacy: Mapper = (s, c) => mapPrivacy(s, c.groups);
const listOp: Mapper = (s, c) => (isScaffoldOverRef(s.arrayRef) ? withArrayRef(s, c.groups, 'arrayRef') : unchanged(s));

const MAPPERS: Record<string, Mapper> = {
    integration_action: mapIntegration,
    call_layer: (s, c) => withInputs(s, autoMapInputs(layerParamSchema(s, c.definition), s.inputs || {}, c.groups, c.opts)),
    // Generic: only fill existing input keys (never invent prompt inputs).
    ai_step: (s, c) => withInputs(s, autoMapInputs(null, s.inputs || {}, c.groups, c.opts)),
    guard: privacy,
    tokenize: privacy,
    untokenize: privacy,
    set: (s, c) => mapSet(s, c.groups, c.opts),
    flatten: (s, c) => mapFlatten(s, c.groups),
    loop: (s, c) => (isScaffoldOverRef(s.overRef) ? withArrayRef(s, c.groups, 'overRef') : unchanged(s)),
    // A fresh Condition wired below a list becomes a list-mode Filter.
    condition: (s, c) => (isScaffoldExpr(s.expr) ? withArrayRef(s, c.groups, 'arrayRef', { type: 'filter' }) : unchanged(s)),
    // Only a switch already IN list mode gets its source bound.
    switch: (s, c) => (typeof s.arrayRef === 'string' && isScaffoldOverRef(s.arrayRef) ? withArrayRef(s, c.groups, 'arrayRef') : unchanged(s)),
};

/**
 * Auto-map a single step; `definition` must already hold the step and its
 * incoming edge. Returns the (possibly) updated step and what was mapped.
 */
export function autoMapStep(
    step: FlowNode | null | undefined,
    definition: FlowDefinition | null | undefined,
    catalog: Catalog | null | undefined,
    opts: AutoMapOptions = {},
): AutoMapResult {
    if (!step || !definition) return { step: step as FlowNode, mappedKeys: [] };
    const groups = computeUpstreamGroups(definition, step.id, catalog, opts.realOutputById || null);
    if (!groups.length) return unchanged(step);
    const type = String(step.type);
    const mapper = Object.hasOwn(MAPPERS, type) ? MAPPERS[type] : LIST_OPS.has(type) ? listOp : undefined;
    return mapper ? mapper(step, { definition, catalog, groups, opts }) : unchanged(step);
}

/**
 * Auto-map one step inside a definition. Mapped INPUT keys (not
 * overRef/arrayRef) are recorded on `step.autoMapped`; a detected type change
 * (condition → filter) re-points the step's edges in the same commit. The
 * definition comes back as the type it went in as: only a step's inputs,
 * its list source, `autoMapped` and (condition → filter) its type change.
 */
export function applyAutoMapToStep<D extends FlowDefinition>(
    definition: D,
    stepId: string,
    catalog: Catalog | null | undefined,
    opts: AutoMapOptions = {},
): { definition: D; mappedKeys: string[]; forEachEnabled: boolean } {
    const steps = definition?.steps || [];
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return { definition, mappedKeys: [], forEachEnabled: false };
    const prev = steps[idx] as FlowNode;
    const { step: mapped, mappedKeys, forEachEnabled } = autoMapStep(prev, definition, catalog, opts);
    if (!mappedKeys.length && !forEachEnabled) return { definition, mappedKeys: [], forEachEnabled: false };
    const inputKeys = mappedKeys.filter((k) => k !== 'overRef' && k !== 'arrayRef');
    const previous = Array.isArray(mapped.autoMapped) ? (mapped.autoMapped as string[]) : [];
    const withMarker = inputKeys.length ? { ...mapped, autoMapped: Array.from(new Set([...previous, ...inputKeys])) } : mapped;
    const nextSteps = steps.slice();
    nextSteps[idx] = withMarker;
    let next = { ...definition, steps: nextSteps } as D;
    if (withMarker.type !== prev.type) next = reconcileRouteEdges(next, stepId, prev, withMarker);
    return { definition: next, mappedKeys, forEachEnabled: !!forEachEnabled };
}
