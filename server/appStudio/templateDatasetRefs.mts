/**
 * App Studio: a template's screens bound to a dataset the template installs.
 *
 * A template declares its datasets with an id of its own (`datasets: [{ id: 'ds_sdmonthly', ... }]`)
 * and its screens bind to that id (`{ kind: 'dataset', datasetId: 'ds_sdmonthly' }`), the way a
 * seed row points at another one with `{ $ref: '<$id>' }`: a name inside the template and nothing
 * more. The installer creates every dataset with a new id of the app (studioAppDataStore
 * createDataset), so after install it rewrites each binding through the map "template id → id in
 * this app" (templateInstall.js). On an upgrade a dataset that already exists by name is mapped to
 * that one. A binding whose id is not in the map is left as it is.
 *
 * The template itself is never rewritten: its bytes and install hash stay what they are, and
 * templates.test.js validates its bindings against its own dataset ids.
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_DEPTH = 64;

/** The template id → app id pairs of one install: a template dataset with an id, and the row that stands for it. */
export function datasetIdMap(pairs: Iterable<[unknown, unknown]>): Map<string, string> {
    const map = new Map<string, string>();
    for (const [from, to] of pairs) {
        if (typeof from === 'string' && from && typeof to === 'string' && to && from !== to) map.set(from, to);
    }
    return map;
}

function walk(value: unknown, depth: number, map: ReadonlyMap<string, string>, count: { n: number }): void {
    if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, map, count); return; }
    const node = value as Obj;
    if (node.kind === 'dataset' && typeof node.datasetId === 'string') {
        const next = map.get(node.datasetId);
        if (next !== undefined) { node.datasetId = next; count.n += 1; }
    }
    for (const item of Object.values(node)) walk(item, depth + 1, map, count);
}

/**
 * Every dataset binding of `definition` whose id is in `map`, rewritten in a copy. `changed` is 0
 * (and `definition` the input itself) when nothing pointed at a mapped id.
 */
export function resolveDatasetRefs(definition: unknown, map: ReadonlyMap<string, string>): { definition: unknown; changed: number } {
    if (!map.size || !isObject(definition)) return { definition, changed: 0 };
    const copy = structuredClone(definition);
    const count = { n: 0 };
    walk(copy, 0, map, count);
    return count.n ? { definition: copy, changed: count.n } : { definition, changed: 0 };
}
