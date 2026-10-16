/**
 * The English dictionary one namespace at a time (issue #252).
 *
 * `en/<ns>.generated.mjs` is written by scripts/gen-i18n-defaults.mjs next to
 * the full `en-defaults.js`. A surface that renders a known set of screens, the
 * public feature demos, loads just those namespaces instead of 3.9 MB, most of
 * it the learning centre. Each namespace is its own chunk, fetched once.
 */
export type NamespaceCatalogue = Record<string, string>;

type Loader = () => Promise<{ default: NamespaceCatalogue }>;

const SUFFIX = '.generated.mjs';
const LOADERS: Record<string, Loader> = {};
for (const [file, load] of Object.entries(import.meta.glob<{ default: NamespaceCatalogue }>('./en/*.generated.mjs'))) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    LOADERS[name.slice(0, -SUFFIX.length)] = load;
}

const cache = new Map<string, Promise<NamespaceCatalogue>>();

export function knownEnNamespaces(): string[] {
    return Object.keys(LOADERS);
}

function loadOne(ns: string): Promise<NamespaceCatalogue> {
    const hit = cache.get(ns);
    if (hit) return hit;
    const load = LOADERS[ns];
    if (!load) return Promise.resolve({});
    const p = load().then((m) => m.default);
    // A failed chunk must not poison the cache: a later surface may retry.
    p.catch(() => { cache.delete(ns); });
    cache.set(ns, p);
    return p;
}

/** The merged keys of the requested namespaces. An unknown namespace adds nothing. */
export async function loadEnNamespaces(namespaces: readonly string[]): Promise<NamespaceCatalogue> {
    const parts = await Promise.all(namespaces.map(loadOne));
    return Object.assign({}, ...parts);
}
