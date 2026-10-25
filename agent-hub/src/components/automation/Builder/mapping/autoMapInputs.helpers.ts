import { sampleType } from './autoMapIteration';
import { groupValueFields, type UpstreamGroup } from './deepFields';
import { getLayerContract } from '../flow/flowletScope';
import type { InputSchema, AutoMapStep, AutoMapDefinition, Candidate } from './autoMapInputs.types';

/**
 * Every one-value field of every upstream group, at ANY depth: the fields the
 * describers offer and what only the sample shows (keys inside JSON text,
 * name/value entries such as `headers[name="Subject"].value`, keys under
 * wrappers like `data.attributes`). Never a list column (`items[*].x` is one
 * value PER ROW, so it would put a list into a one-value parameter) and never
 * a per-iteration field (BFSF-369): those stay pickable by hand. A column
 * reaches a LIST input through autoMapListInput.ts (`messageIds` ←
 * `results[*].id`), and the "run once per item" pass maps one per item.
 */
export function flattenCandidates(groups: UpstreamGroup[] | null | undefined): Candidate[] {
    const out: Candidate[] = [];
    (groups || []).forEach((g, gi) => {
        groupValueFields(g).forEach((f, fi) => {
            out.push({ key: f.key, path: f.path, type: sampleType(f.sample), sample: f.sample, groupLabel: g.label, groupIndex: gi, fieldIndex: fi, weight: f.weight });
        });
    });
    return out;
}

/**
 * Nearest = highest groupIndex (closest upstream node), then the field that
 * sits least deep (wrappers such as `data` do not count), then data order.
 */
export function chooseNearest(list: Candidate[], used: Set<string>): Candidate | null {
    if (!list.length) return null;
    const unused = list.filter((c: Candidate) => !used.has(c.path));
    const pool = unused.length ? unused : list;
    return pool.slice().sort((a, b) => (b.groupIndex - a.groupIndex) || (a.weight - b.weight) || (a.fieldIndex - b.fieldIndex))[0];
}

/**
 * Build a pseudo input-schema for a call_layer node. The contract derives
 * live from `definition.layers[step.layerKey]` (inline flowlets). When the
 * definition in hand has no layers map (e.g. the canvas is scoped inside
 * a flowlet and a sibling call_layer is being mapped), fall back to the
 * step's existing input keys — generic mode, never inventing keys.
 */
export function layerParamSchema(step: AutoMapStep, definition: AutoMapDefinition): InputSchema {
    const { params } = getLayerContract(definition, step.layerKey as string);
    if (params.length) {
        return {
            properties: Object.fromEntries(params.map((p: { name: string; type?: string; required?: boolean }) => [p.name, { type: p.type }])),
            required: params.filter((p: { required?: boolean }) => p.required).map((p: { name: string }) => p.name),
        };
    }
    const keys = Object.keys(step.inputs || {});
    return { properties: Object.fromEntries(keys.map((k: string) => [k, {}])), required: [] };
}

/**
 * Is this over/arrayRef still the palette scaffold (never user-chosen)?
 * The literal 'trigger.output.items' is the legacy seed every Lists/Loop node
 * used to carry — treating it as scaffold lets auto-map heal already-saved
 * nodes on re-connect. New nodes seed '' (C20).
 */
export function isScaffoldOverRef(ref: unknown): boolean {
    return !ref || ref === 'trigger.output.items';
}

/**
 * Is this condition still the untouched palette scaffold? `buildStepFromPayload`
 * seeds `expr: 'true'` (the parser needs something valid); anything else means
 * the author has already said what the step decides, and auto-detection must
 * keep its hands off.
 */
export function isScaffoldExpr(expr: unknown): boolean {
    const src = String(expr || '').trim();
    return src === '' || src === 'true';
}
