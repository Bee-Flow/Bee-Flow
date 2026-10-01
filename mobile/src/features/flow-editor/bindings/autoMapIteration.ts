/**
 * Auto-map for a step that runs once per item: its own item is the nearest
 * source, so its empty inputs are matched to the item's fields first — an
 * `each` pick under a `repeat`, a `loop.<itemVar>` ref under the older
 * forEach. Auto-map never switches a per-item run ON (that is the author's
 * call, in the step's settings). From agent-hub
 * `Builder/mapping/autoMapInputs.ts` (itemScopeOf / mapFromItem).
 */

import { formatPath, matchInputs, sampleType } from '@/shared/mapping';
import type { MappingSource, MatchCandidate } from '@/shared/mapping';

import { emptyInputs } from './autoMap';
import { isObj } from './json';
import { buildSampleRoot } from './realOutputs';
import type { Binding, Catalog, FlowDefinition, FlowNode, JsonSchema, VariableGroup } from './types';
import { buildToolOutputMap, inferLoopItemSample } from './upstream';

/** Where the step sits: the definition and the catalog its tools come from. */
export interface IterationContext {
    definition: FlowDefinition;
    catalog: Catalog | null | undefined;
}

export interface ItemMapping {
    patch: Record<string, Binding>;
    /** The upstream group that offers the same item as `loop.<itemVar>.*`, if any. */
    groupId: string | null;
}

/**
 * One list item's fields as candidates; `path` is the segment list inside
 * the item, JSON-encoded. A fan-out entry offers `output.<f>` and
 * `item.<f>`, keyed by `<f>`; a plain item its fields and one level deeper,
 * the deeper ones one `depth` down.
 */
function itemCandidates(element: unknown, fanout: boolean): MatchCandidate[] {
    if (!isObj(element)) return [];
    const out: MatchCandidate[] = [];
    const add = (key: string, path: string[], value: unknown, depth = 0) => out.push({ key, path: JSON.stringify(path), type: sampleType(value), depth });
    if (fanout) {
        for (const half of ['output', 'item']) {
            const v = element[half];
            if (isObj(v)) for (const [k, x] of Object.entries(v)) add(k, [half, k], x);
        }
        return out;
    }
    for (const [k, v] of Object.entries(element)) {
        add(k, [k], v);
        // One level down ranks after the item's own fields: `from.id` never
        // ties with the item's `id`.
        if (isObj(v)) for (const [ck, cv] of Object.entries(v)) add(ck, [k, ck], cv, 1);
    }
    return out;
}

/** Is this list the `results` of a step that ran once per item? */
function isFanOutList(source: MappingSource | null, definition: FlowDefinition): boolean {
    if (!source || source.root !== 'steps' || source.path.length !== 1 || source.path[0] !== 'results') return false;
    const step = (definition.steps || []).find((s) => s.id === source.id);
    return !!(step && (step.forEach?.overRef || step.repeat));
}

interface ItemScope {
    candidates: MatchCandidate[];
    bind: (path: string[]) => Binding;
    groupId: string | null;
}

function itemScopeOf(step: FlowNode, groups: VariableGroup[], { definition, catalog }: IterationContext): ItemScope | null {
    const toolToOutput = buildToolOutputMap(catalog);
    const sampleRoot = buildSampleRoot(groups);
    const over = (step.repeat as { over?: MappingSource } | null | undefined)?.over;
    if (over) {
        const listPath = formatPath(over as never);
        if (!listPath) return null;
        return {
            candidates: itemCandidates(inferLoopItemSample(listPath, definition, toolToOutput, sampleRoot), isFanOutList(over, definition)),
            bind: (path) => ({ kind: 'pick', v: 1, from: { ...over, path: [...over.path, ...path] }, take: 'each', as: 'native' }) as unknown as Binding,
            groupId: null,
        };
    }
    const fe = step.forEach;
    if (!fe || typeof fe.overRef !== 'string' || !fe.overRef.trim()) return null;
    const itemVar = fe.itemVar || 'item';
    const listPath = fe.overRef.trim();
    const m = /^steps\.([^.[]+)\.output\.results$/.exec(listPath);
    const fanout = !!m && isFanOutList({ root: 'steps', id: m[1] as string, path: ['results'] }, definition);
    return {
        candidates: itemCandidates(inferLoopItemSample(listPath, definition, toolToOutput, sampleRoot), fanout),
        bind: (path) => ({ kind: 'ref', path: formatPath({ root: 'loop', id: itemVar, path } as never) as string }),
        groupId: `${step.id}__foreach`,
    };
}

/**
 * The empty inputs of a repeating step, bound from its current item: each
 * item field once at most, `<entity>Id` to the item's own `id` (once), and a
 * name a fan-out entry has under output AND item left for the author. Null
 * when the step does not repeat.
 */
export function mapFromItem(
    step: FlowNode,
    schema: JsonSchema | null | undefined,
    groups: VariableGroup[],
    ctx: IterationContext,
): ItemMapping | null {
    const scope = itemScopeOf(step, groups, ctx);
    if (!scope) return null;
    if (!scope.candidates.length) return { patch: {}, groupId: scope.groupId };
    const { matches } = matchInputs(emptyInputs(schema, step.inputs || {}), scope.candidates, { idAffinity: true, unique: true, ambiguous: true, skipSecrets: true });
    return { patch: Object.fromEntries(matches.map((m) => [m.key, scope.bind(JSON.parse(m.path) as string[])])), groupId: scope.groupId };
}
