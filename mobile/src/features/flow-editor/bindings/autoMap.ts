/**
 * Automatic input mapping: when A → B is connected, fill B's still-EMPTY
 * inputs with `{kind:'ref'}` bindings to matching upstream outputs.
 * Conservative by design — exact and normalised name matches only, gated by
 * type, never overwriting what the user set, nearest upstream first. Port of
 * the matching half of agent-hub `Builder/mapping/autoMapInputs.js` (the
 * "run once per item" fallback is autoMapIteration.ts, the per-step-type half
 * autoMapStep.ts); pinned by autoMap.lockstep.test.ts.
 */

import { isEmptyBinding } from './partitionInputs';
import { matchSchema } from './schemaMatch';
import type { Binding, Catalog, JsonSchema, VariableField, VariableGroup } from './types';

export function normalizeKey(name: unknown): string {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function sampleType(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

export function isSecretLikeKey(key: unknown): boolean {
    return /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key)/i.test(String(key || ''));
}

/** JSON-Schema property type vs an upstream sample's type. Permissive when unknown. */
export function typeCompatible(propType: unknown, candType: string): boolean {
    if (!propType || !candType || candType === 'null') return true;
    let pt = propType;
    if (Array.isArray(pt)) pt = pt.find((x) => x !== 'null') || pt[0];
    if (pt === 'integer') pt = 'number';
    if (pt === 'string') return ['string', 'number', 'boolean'].includes(candType);
    return pt === candType;
}

/** A tool's inputSchema from the catalog. */
export function findInputSchemaForTool(catalog: Catalog | null | undefined, tool: unknown): JsonSchema | null {
    for (const app of catalog?.apps || []) {
        for (const action of app.actions || []) {
            if (action?.name === tool) return action.inputSchema || null;
        }
    }
    return null;
}

interface Candidate {
    key: string;
    path: string;
    type: string;
    sample?: unknown;
    groupLabel?: string;
    groupIndex: number;
    fieldIndex: number;
}

function pushField(out: Candidate[], f: VariableField, group: { index: number; label?: string }, fi: number): number {
    const gi = group.index;
    const groupLabel = group.label;
    out.push({ key: f.key, path: f.path, type: sampleType(f.sample), sample: f.sample, groupLabel, groupIndex: gi, fieldIndex: fi++ });
    for (const c of f.children || []) {
        // `[*]` children resolve to an ARRAY at run time — never a scalar param.
        if (/\[\*\]/.test(c.path)) continue;
        out.push({ key: c.key, path: c.path, type: sampleType(c.sample), sample: c.sample, groupLabel, groupIndex: gi, fieldIndex: fi++ });
    }
    return fi;
}

/** Upstream groups (and one nesting level) as candidates; per-iteration fields skipped (BFSF-369). */
function flattenCandidates(groups: VariableGroup[] | null | undefined): Candidate[] {
    const out: Candidate[] = [];
    (groups || []).forEach((g, gi) => {
        let fi = 0;
        for (const f of g.fields || []) {
            if (f.perIteration) fi++;
            else fi = pushField(out, f, { index: gi, label: g.label }, fi);
        }
    });
    return out;
}

/** Nearest = highest groupIndex, then earliest field; unused paths first. */
function chooseNearest(list: Candidate[], used: Set<string>): Candidate | null {
    if (!list.length) return null;
    const unused = list.filter((c) => !used.has(c.path));
    const pool = unused.length ? unused : list;
    return pool.slice().sort((a, b) => b.groupIndex - a.groupIndex || a.fieldIndex - b.fieldIndex)[0] ?? null;
}

function bestCandidate(key: string, propType: unknown, candidates: Candidate[], used: Set<string>): Candidate | null {
    const exact = candidates.filter((c) => c.key === key && typeCompatible(propType, c.type));
    const pick = chooseNearest(exact, used);
    if (pick) return pick;
    const nkey = normalizeKey(key);
    return chooseNearest(candidates.filter((c) => normalizeKey(c.key) === nkey && typeCompatible(propType, c.type)), used);
}

const ARRAY_NAME_RE = /items|results|rows|records|data|list|messages|emails|events|files|entries/i;

/** Nearest upstream array-typed field path (a loop's overRef, a list op's arrayRef). */
export function nearestArrayRef(groups: VariableGroup[] | null | undefined): string | null {
    const list = groups || [];
    for (let gi = list.length - 1; gi >= 0; gi--) {
        const fields = ((list[gi] as VariableGroup).fields || []).filter((f) => !f.perIteration);
        const preferred = fields.find((f) => sampleType(f.sample) === 'array' && ARRAY_NAME_RE.test(f.key));
        if (preferred) return preferred.path;
        const anyArr = fields.find((f) => sampleType(f.sample) === 'array');
        if (anyArr) return anyArr.path;
    }
    return null;
}

// Where a person's free text lives, ORDERED: long-form fields first.
const SCANNABLE_NAME_RES = [
    /^(body|text|content|transcript|full_?text)$/i,
    /body|text|content|transcript|message|description|summary|notes?|comment|answer|html/i,
    /subject|title|name/i,
];

function nearestField(groups: VariableGroup[], match: (f: VariableField) => boolean): string | null {
    for (let gi = groups.length - 1; gi >= 0; gi--) {
        const found = ((groups[gi] as VariableGroup).fields || []).find(match);
        if (found) return found.path;
    }
    return null;
}

/** The nearest upstream value worth handing a PII detector. */
export function nearestScannableRef(groups: VariableGroup[] | null | undefined): string | null {
    const list = groups || [];
    for (const re of SCANNABLE_NAME_RES) {
        const named = nearestField(list, (f) => sampleType(f.sample) === 'string' && re.test(f.key));
        if (named) return named;
    }
    const anyText = nearestField(list, (f) => sampleType(f.sample) === 'string');
    if (anyText) return anyText;
    return list[list.length - 1]?.basePath || null;
}

/** Required keys first, so the most important fields win the nearest candidate. */
export function requiredFirst(keys: string[], required: Set<string>): string[] {
    return keys.slice().sort((a, b) => (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0));
}

interface MapPass {
    properties: Record<string, { type?: unknown }> | null;
    candidates: Candidate[];
    existing: Record<string, unknown>;
    used: Set<string>;
}

/** The binding for one key, or null (already set, secret-like, or no match). */
function mapOne(key: string, pass: MapPass): Binding | null {
    if (!isEmptyBinding(pass.existing[key]) || isSecretLikeKey(key)) return null;
    const match = bestCandidate(key, pass.properties?.[key]?.type, pass.candidates, pass.used);
    if (!match) return null;
    pass.used.add(match.path);
    return { kind: 'ref', path: match.path };
}

/** What names alone did not settle: schema matching (schemaMatch.ts), into `patch`. */
function schemaPass(keys: string[], patch: Record<string, Binding>, pass: MapPass, maxPerStep: number): void {
    const rest = keys.filter((k) => !patch[k] && isEmptyBinding(pass.existing[k]) && !isSecretLikeKey(k));
    if (!rest.length || Object.keys(patch).length >= maxPerStep) return;
    const params = rest.map((k) => ({ key: k, ...((pass.properties?.[k] as Record<string, unknown>) || {}) }));
    for (const r of matchSchema(params, pass.candidates, pass.used)) {
        if (Object.keys(patch).length >= maxPerStep) break;
        patch[r.key] = { kind: 'ref', path: r.path };
        pass.used.add(r.path);
    }
}

/**
 * Only NEW `{kind:'ref'}` bindings for still-empty keys. Without a schema only
 * the step's existing keys are considered — never invented.
 */
export function autoMapInputs(
    targetInputSchema: JsonSchema | null | undefined,
    existingInputs: Record<string, unknown> | null | undefined,
    upstreamGroups: VariableGroup[] | null | undefined,
    opts: { maxPerStep?: number } = {},
): Record<string, Binding> {
    const maxPerStep = opts.maxPerStep ?? 12;
    const properties = targetInputSchema?.properties || null;
    const candidates = flattenCandidates(upstreamGroups);
    if (!candidates.length) return {};
    const pass: MapPass = { properties, candidates, existing: existingInputs || {}, used: new Set() };
    const keys = requiredFirst(properties ? Object.keys(properties) : Object.keys(pass.existing), new Set(targetInputSchema?.required || []));
    const patch: Record<string, Binding> = {};
    for (const key of keys) {
        if (Object.keys(patch).length >= maxPerStep) break;
        const binding = mapOne(key, pass);
        if (binding) patch[key] = binding;
    }
    schemaPass(keys, patch, pass, maxPerStep);
    return patch;
}
