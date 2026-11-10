import { assetIdOf } from '../../runtime/assets/assetUrl';

const MAX_DEPTH = 64;

function join(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path ? `${path}.${key}` : key;
}

/**
 * Every path in `definition` whose value is `asset:<assetId>` (the editor's own, possibly
 * unsaved, copy). The server's appAssets.mts collectAssetRefs walks the same way.
 */
export function assetPathsIn(definition: unknown, assetId: string): string[] {
    const out: string[] = [];
    const walk = (value: unknown, path: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        if (typeof value === 'string') {
            if (assetIdOf(value) === assetId) out.push(path);
            return;
        }
        if (Array.isArray(value)) value.forEach((item, i) => walk(item, join(path, i), depth + 1));
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, join(path, k), depth + 1);
    };
    walk(definition, '', 0);
    return out;
}
