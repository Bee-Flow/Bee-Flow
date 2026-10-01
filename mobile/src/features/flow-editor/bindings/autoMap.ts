/**
 * Automatic input mapping: when A → B is connected, fill B's still-EMPTY
 * inputs with `{kind:'ref'}` bindings to matching upstream outputs.
 * Conservative by design — name matches only, gated by type, never
 * overwriting what the user set, nearest upstream first. WHICH name matches
 * is the shared core's one rule (shared/mapping matchInputs), the same the
 * web builder and the AI builder use. Port of the matching half of agent-hub
 * `Builder/mapping/autoMapInputs.ts` (a repeating step's own item is
 * autoMapIteration.ts, the per-step-type half autoMapStep.ts); pinned by
 * autoMap.lockstep.test.ts.
 */

import { isSecretLikeKey, matchInputs, normalizeKey, sampleType } from '@/shared/mapping';
import type { MatchCandidate, MatchInput } from '@/shared/mapping';

import { isEmptyBinding } from './partitionInputs';
import type { Binding, Catalog, JsonSchema, VariableField, VariableGroup } from './types';

export { isSecretLikeKey, normalizeKey, sampleType };

/** A tool's inputSchema from the catalog. */
export function findInputSchemaForTool(catalog: Catalog | null | undefined, tool: unknown): JsonSchema | null {
    for (const app of catalog?.apps || []) {
        for (const action of app.actions || []) {
            if (action?.name === tool) return action.inputSchema || null;
        }
    }
    return null;
}

function pushField(out: MatchCandidate[], f: VariableField, near: number): void {
    out.push({ key: f.key, path: f.path, type: sampleType(f.sample), near });
    for (const c of f.children || []) {
        // `[*]` children resolve to an ARRAY at run time — never a scalar param.
        if (/\[\*\]/.test(c.path)) continue;
        out.push({ key: c.key, path: c.path, type: sampleType(c.sample), near });
    }
}

/** Upstream groups (and one nesting level) as candidates; per-iteration fields skipped (BFSF-369). */
function groupCandidates(groups: VariableGroup[] | null | undefined): MatchCandidate[] {
    const out: MatchCandidate[] = [];
    (groups || []).forEach((g, gi) => {
        for (const f of g.fields || []) if (!f.perIteration) pushField(out, f, gi);
    });
    return out;
}

const ARRAY_NAME_RE = /items|results|rows|records|data|list|messages|emails|events|files|entries/i;

/**
 * Nearest upstream list (a loop's overRef, a list op's arrayRef). A step that
 * ran once per item IS a list, its `results`; walking past it picked an older
 * list two steps back.
 */
export function nearestArrayRef(groups: VariableGroup[] | null | undefined): string | null {
    const list = groups || [];
    for (let gi = list.length - 1; gi >= 0; gi--) {
        const g = list[gi] as VariableGroup & { forEach?: boolean };
        if (g.forEach && g.basePath) return `${g.basePath}.results`;
        const fields = (g.fields || []).filter((f) => !f.perIteration);
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

/** The inputs a schema (or, without one, the existing keys) asks to fill, empty ones only. */
export function emptyInputs(schema: JsonSchema | null | undefined, existing: Record<string, unknown> | null | undefined): MatchInput[] {
    const properties = schema?.properties || null;
    const required = new Set(schema?.required || []);
    const keys = properties ? Object.keys(properties) : Object.keys(existing || {});
    return keys
        .filter((key) => isEmptyBinding((existing || {})[key]))
        .map((key) => ({ key, type: properties?.[key]?.type as MatchInput['type'], required: required.has(key) }));
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
    const candidates = groupCandidates(upstreamGroups);
    if (!candidates.length) return {};
    const { matches } = matchInputs(emptyInputs(targetInputSchema, existingInputs), candidates, { skipSecrets: true, max: opts.maxPerStep ?? 12 });
    return Object.fromEntries(matches.map((m) => [m.key, { kind: 'ref', path: m.path } as Binding]));
}
