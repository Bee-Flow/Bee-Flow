/**
 * The "run once per item" fallback of auto-map: when a step's REQUIRED inputs
 * cannot be filled from scalar upstream fields but the nearest upstream is an
 * ARRAY of objects whose element fields match, bind the inputs to
 * `loop.<itemVar>.<field>` and hand back the `forEach` the runtime fans out
 * over. From agent-hub `Builder/mapping/autoMapInputs.js` tryIterationMapping.
 */

import { isSecretLikeKey, nearestArrayRef, normalizeKey, requiredFirst, sampleType, typeCompatible } from './autoMap';
import { isObj } from './json';
import { isEmptyBinding } from './partitionInputs';
import { buildSampleRoot } from './realOutputs';
import { matchSchema } from './schemaMatch';
import type { Binding, Catalog, FlowDefinition, ForEach, JsonSchema, VariableGroup } from './types';
import { buildToolOutputMap, inferLoopItemSample, sampleToFields, suggestItemVar } from './upstream';

export interface IterationMapping {
    patch: Record<string, Binding>;
    forEach: ForEach;
}

interface Cand {
    key: string;
    path: string;
    type: string;
    sample?: unknown;
    groupLabel?: string;
    groupIndex: number;
}

function lastSegmentKey(path: string): string {
    const parts = String(path || '').split('.');
    return parts[parts.length - 1] || '';
}

/** `messageId` / `message_id` → 'message'; null when the key isn't id-suffixed. */
function idAffinityBase(key: string): string | null {
    const m = /^(.+?)[_]?id$/i.exec(String(key || ''));
    return m && m[1] ? m[1] : null;
}

function elementCandidates(elementSample: Record<string, unknown>, itemVar: string): Cand[] {
    const out: Cand[] = [];
    for (const f of sampleToFields(elementSample, `loop.${itemVar}`)) {
        out.push({ key: f.key, path: f.path, type: sampleType(f.sample), sample: f.sample, groupLabel: itemVar, groupIndex: 0 });
        for (const c of f.children || []) out.push({ key: c.key, path: c.path, type: sampleType(c.sample), sample: c.sample, groupLabel: itemVar, groupIndex: 0 });
    }
    return out;
}

interface MatchState {
    used: Set<string>;
    idAffinityUsed: boolean;
    idField: Cand | undefined;
}

function matchKey(key: string, propType: unknown, candidates: Cand[], st: MatchState): Cand | undefined {
    const fits = (c: Cand) => !st.used.has(c.path) && typeCompatible(propType, c.type);
    const nkey = normalizeKey(key);
    const match = candidates.find((c) => fits(c) && c.key === key) || candidates.find((c) => fits(c) && normalizeKey(c.key) === nkey);
    if (match) return match;
    // `<entity>Id` ↔ element `id`, once, for the primary identifier.
    const id = st.idField;
    if (st.idAffinityUsed || !id || st.used.has(id.path) || !idAffinityBase(key) || !typeCompatible(propType, id.type)) return undefined;
    st.idAffinityUsed = true;
    return id;
}

/** The element of the nearest upstream array, as a plain object, or null. */
function nearestElement(groups: VariableGroup[], definition: FlowDefinition, catalog: Catalog | null | undefined): { overRef: string; element: Record<string, unknown> } | null {
    const overRef = nearestArrayRef(groups);
    if (!overRef) return null;
    const element = inferLoopItemSample(overRef, definition, buildToolOutputMap(catalog), buildSampleRoot(groups));
    return isObj(element) ? { overRef, element } : null;
}

/** Where the step sits: the definition and the catalog its tools come from. */
export interface IterationContext {
    definition: FlowDefinition;
    catalog: Catalog | null | undefined;
}

function matchAll(keys: string[], properties: NonNullable<JsonSchema['properties']>, candidates: Cand[], existing: Record<string, unknown>): { patch: Record<string, Binding>; matched: string[] } {
    const st: MatchState = { used: new Set(), idAffinityUsed: false, idField: candidates.find((c) => c.key === 'id') };
    const patch: Record<string, Binding> = {};
    const matched: string[] = [];
    for (const key of keys) {
        if (!isEmptyBinding(existing[key]) || isSecretLikeKey(key)) continue;
        const match = matchKey(key, properties[key]?.type, candidates, st);
        if (!match) continue;
        patch[key] = { kind: 'ref', path: match.path };
        st.used.add(match.path);
        matched.push(key);
    }
    // The same schema-matching layer as the single-value pass, per item.
    const left = keys.filter((k) => !patch[k] && isEmptyBinding(existing[k]) && !isSecretLikeKey(k));
    for (const r of matchSchema(left.map((k) => ({ key: k, ...((properties[k] as Record<string, unknown>) || {}) })), candidates, st.used)) {
        patch[r.key] = { kind: 'ref', path: r.path };
        st.used.add(r.path);
        matched.push(r.key);
    }
    return { patch, matched };
}

/**
 * Only from a declared schema with REQUIRED inputs, only for inputs the scalar
 * pass left empty, only on exact / normalised name + type matches (plus one
 * `<entity>Id` ↔ `id` affinity), and only when a required input is satisfied.
 * (The web takes the context positionally: definition, catalog.)
 */
export function tryIterationMapping(
    schema: JsonSchema | null | undefined,
    existingInputs: Record<string, unknown> | null | undefined,
    groups: VariableGroup[],
    { definition, catalog }: IterationContext,
): IterationMapping | null {
    const properties = schema?.properties || null;
    const required = new Set(schema?.required || []);
    if (!properties || !required.size) return null;
    const source = nearestElement(groups, definition, catalog);
    if (!source) return null;
    const itemVar = suggestItemVar(lastSegmentKey(source.overRef));
    const candidates = elementCandidates(source.element, itemVar);
    if (!candidates.length) return null;
    const keys = requiredFirst(Object.keys(properties), required);
    const { patch, matched } = matchAll(keys, properties, candidates, existingInputs || {});
    if (!matched.some((k) => required.has(k))) return null;
    return { patch, forEach: { overRef: source.overRef, itemVar, maxIterations: 100 } };
}
