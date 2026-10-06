/**
 * Automatic input mapping: when A → B is connected, fill B's still-EMPTY
 * inputs with `{kind:'ref'}` bindings to matching upstream outputs.
 * Conservative by design — exact and normalised name matches only, gated by
 * type, never overwriting what the user set, nearest upstream first. Port of
 * the matching half of agent-hub `Builder/mapping/autoMapInputs.js` (the
 * "run once per item" fallback is autoMapIteration.ts, the per-step-type half
 * autoMapStep.ts); pinned by autoMap.lockstep.test.ts.
 */

import { firstKeyIsDiagnostic, sampleType, typeCompatible } from './autoMapIteration';
import { listColumnPatch } from './autoMapListInput';
import { ownItemIdPatch } from './autoMapOwnItem';
import { foldKey, groupListSources, groupValueFields, isRecord } from './deepFields';
import { isEmptyBinding } from './partitionInputs';
import { matchSchema } from './schemaMatch';
import type { Binding, Catalog, JsonSchema, VariableField, VariableGroup } from './types';
import { isDiagnosticOutputKey } from './upstream/stepPayload';


/** A key as a person means it: case, separators and accents do not count (deepFields.foldKey). */
export function normalizeKey(name: unknown): string {
    return foldKey(name);
}

export function isSecretLikeKey(key: unknown): boolean {
    return /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key)/i.test(String(key || ''));
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
    weight: number;
}

/**
 * Every one-value field of every upstream group, at ANY depth (deepFields):
 * never a list column and never a per-iteration field (BFSF-369). A column
 * reaches a LIST input through autoMapListInput.ts.
 */
function flattenCandidates(groups: VariableGroup[] | null | undefined): Candidate[] {
    const out: Candidate[] = [];
    (groups || []).forEach((g, gi) => {
        groupValueFields(g).forEach((f, fi) => {
            out.push({ key: f.key, path: f.path, type: sampleType(f.sample), sample: f.sample, groupLabel: g.label, groupIndex: gi, fieldIndex: fi, weight: f.weight });
        });
    });
    return out;
}

/** Nearest = highest groupIndex, then the field least deep (wrappers do not count), then data order; unused paths first. */
function chooseNearest(list: Candidate[], used: Set<string>): Candidate | null {
    if (!list.length) return null;
    const unused = list.filter((c) => !used.has(c.path));
    const pool = unused.length ? unused : list;
    return pool.slice().sort((a, b) => b.groupIndex - a.groupIndex || a.weight - b.weight || a.fieldIndex - b.fieldIndex)[0] ?? null;
}

function bestCandidate(key: string, propType: unknown, candidates: Candidate[], used: Set<string>): Candidate | null {
    const exact = candidates.filter((c) => c.key === key && typeCompatible(propType, c.type));
    const pick = chooseNearest(exact, used);
    if (pick) return pick;
    const nkey = normalizeKey(key);
    return chooseNearest(candidates.filter((c) => normalizeKey(c.key) === nkey && typeCompatible(propType, c.type)), used);
}

const ARRAY_NAME_RE = /items|results|rows|records|data|list|messages|emails|events|files|entries|value/i;

type OwnFlag = { ownItem?: boolean };

/**
 * The nearest upstream list (a loop's overRef, a list op's arrayRef), at any
 * depth: a plain list before a column of a list inside a list, records before
 * plain values, a list-like name, then the shallowest. A Code step's `logs`
 * and `httpCalls` are never the list; a step's own item is not a source for itself.
 */
export function nearestArrayRef(groups: VariableGroup[] | null | undefined): string | null {
    const list = groups || [];
    for (let gi = list.length - 1; gi >= 0; gi--) {
        const g = list[gi] as VariableGroup & OwnFlag;
        if (g.ownItem) continue;
        const sources = groupListSources(g).filter((s) => !firstKeyIsDiagnostic(g, s.path, isDiagnosticOutputKey));
        if (!sources.length) continue;
        const rank = (s: (typeof sources)[number]) => [s.chain.length, isRecord(s.element) ? 0 : 1, ARRAY_NAME_RE.test(s.key) ? 0 : 1, s.weight, s.depth];
        const best = sources
            .map((s, i) => ({ s, r: [...rank(s), i] }))
            .sort((a, b) => {
                for (let k = 0; k < a.r.length; k++) if (a.r[k] !== b.r[k]) return (a.r[k] as number) - (b.r[k] as number);
                return 0;
            })[0];
        if (best) return best.s.path;
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
    opts: { maxPerStep?: number; listColumns?: boolean } = {},
): Record<string, Binding> {
    const maxPerStep = opts.maxPerStep ?? 12;
    const properties = targetInputSchema?.properties || null;
    const candidates = flattenCandidates(upstreamGroups);
    const pass: MapPass = { properties, candidates, existing: existingInputs || {}, used: new Set() };
    const keys = requiredFirst(properties ? Object.keys(properties) : Object.keys(pass.existing), new Set(targetInputSchema?.required || []));
    const patch: Record<string, Binding> = {};
    for (const key of keys) {
        if (Object.keys(patch).length >= maxPerStep) break;
        const binding = mapOne(key, pass);
        if (binding) patch[key] = binding;
    }
    // A list input of the schema takes a column of an upstream list (`results[*].id`).
    listColumnPatch({ keys, schema: targetInputSchema, existing: pass.existing, groups: upstreamGroups, used: pass.used, maxPerStep, off: opts.listColumns === false }, patch);
    schemaPass(keys, patch, pass, maxPerStep);
    if (properties && Object.keys(patch).length < maxPerStep) ownItemIdPatch({ keys, schema: targetInputSchema, existing: pass.existing, groups: upstreamGroups }, patch);
    return patch;
}
