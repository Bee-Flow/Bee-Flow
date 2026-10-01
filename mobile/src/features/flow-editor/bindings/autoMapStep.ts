/**
 * Auto-map ONE step against its upstream context, per step type — and apply
 * that to a definition, marking the filled keys `autoMapped` so the editor can
 * show the "auto" pill. From agent-hub `Builder/mapping/autoMapInputs.ts`
 * (autoMapStep / applyAutoMapToStep); pinned by autoMap.lockstep.test.ts.
 */

import { autoMapInputs, findInputSchemaForTool, nearestArrayRef, nearestScannableRef } from './autoMap';
import { mapFromItem } from './autoMapIteration';
import { getLayerContract } from './flowDeps/flowletScope';
import type { Catalog, FlowDefinition, FlowNode, JsonSchema, VariableGroup } from './types';
import { computeUpstreamGroups } from './upstream';
import { reconcileRouteEdges } from '../model/route/routeEdges';

export interface AutoMapOptions {
    maxPerStep?: number;
    realOutputById?: Map<string, unknown> | null;
}

export interface AutoMapResult {
    step: FlowNode;
    mappedKeys: string[];
}

const LIST_OPS = new Set(['filter', 'limit', 'dedupe', 'aggregate', 'summarize']);

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

/**
 * A repeating step's own item first (never switching a per-item run on),
 * then the rest from upstream, without offering the item a second time.
 */
function mapIntegration(step: FlowNode, { definition, catalog, groups, opts }: MapContext): AutoMapResult {
    const schema = findInputSchemaForTool(catalog, step.tool);
    const item = mapFromItem(step, schema, groups, { definition, catalog });
    const fromItem = item?.patch || {};
    const withItem: Record<string, unknown> = { ...(step.inputs || {}), ...fromItem };
    const upstream = item?.groupId ? groups.filter((g) => g.id !== item.groupId) : groups;
    const patch = autoMapInputs(schema, withItem, upstream, opts);
    const keys = [...Object.keys(fromItem), ...Object.keys(patch)];
    if (!keys.length) return unchanged(step);
    return { step: { ...step, inputs: { ...withItem, ...patch } as FlowNode['inputs'] }, mappedKeys: keys };
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
        && !step.repeat
        && typeof step.arrayRef !== 'string'
        && !(Array.isArray(step.operations) && step.operations.length);
    const listSource = pristine || (typeof step.arrayRef === 'string' && isScaffoldOverRef(step.arrayRef));
    if (listSource && nearestArrayRef(groups)) return withArrayRef(step, groups, 'arrayRef');
    return withInputs(step, autoMapInputs(null, (step.fields as Record<string, unknown>) || {}, groups, opts), 'fields');
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
): { definition: D; mappedKeys: string[] } {
    const steps = definition?.steps || [];
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return { definition, mappedKeys: [] };
    const prev = steps[idx] as FlowNode;
    const { step: mapped, mappedKeys } = autoMapStep(prev, definition, catalog, opts);
    if (!mappedKeys.length) return { definition, mappedKeys: [] };
    const inputKeys = mappedKeys.filter((k) => k !== 'overRef' && k !== 'arrayRef');
    const previous = Array.isArray(mapped.autoMapped) ? (mapped.autoMapped as string[]) : [];
    const withMarker = inputKeys.length ? { ...mapped, autoMapped: Array.from(new Set([...previous, ...inputKeys])) } : mapped;
    const nextSteps = steps.slice();
    nextSteps[idx] = withMarker;
    let next = { ...definition, steps: nextSteps } as D;
    if (withMarker.type !== prev.type) next = reconcileRouteEdges(next, stepId, prev, withMarker);
    return { definition: next, mappedKeys };
}
