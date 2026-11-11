/**
 * App Studio: uploaded files named by a template's sample rows.
 *
 * A sample row may hold a whole `asset:<id>` string as a value (a product's picture in a text
 * field that an image reads with `srcFrom`). The id names an entry of the template's `assets`,
 * like a reference in its definition does (portableAssets.mts). On install the files are stored
 * in the new app first, and the rows are written with the ids they got there; a value whose file
 * did not arrive becomes null, as a whole reference in the definition does. Only whole values are
 * read: text that merely mentions an asset is the author's and is left alone.
 */

import { ASSET_PREFIX, isAssetRef } from './appAssets.mts';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function eachValue(seed: unknown, visit: (row: Obj, key: string, ref: string) => void): void {
    if (!isObject(seed)) return;
    for (const rows of Object.values(seed)) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            if (!isObject(row)) continue;
            for (const [key, value] of Object.entries(row)) if (isAssetRef(value)) visit(row, key, value);
        }
    }
}

/** The asset ids the sample rows name. */
export function seedAssetIds(seed: unknown): Set<string> {
    const ids = new Set<string>();
    eachValue(seed, (_row, _key, ref) => ids.add(ref.slice(ASSET_PREFIX.length)));
    return ids;
}

/** The sample rows with every whole asset value rewritten through `ids` (copy id → id in this app), in a copy; not in it → null. */
export function remapSeedAssets(seed: unknown, ids: ReadonlyMap<string, string>): { seed: unknown; remapped: number; cleared: number } {
    if (!seedAssetIds(seed).size) return { seed, remapped: 0, cleared: 0 };
    const copy = structuredClone(seed);
    let remapped = 0;
    let cleared = 0;
    eachValue(copy, (row, key, ref) => {
        const next = ids.get(ref.slice(ASSET_PREFIX.length));
        row[key] = next === undefined ? null : `${ASSET_PREFIX}${next}`;
        if (next === undefined) cleared += 1; else remapped += 1;
    });
    return { seed: copy, remapped, cleared };
}
