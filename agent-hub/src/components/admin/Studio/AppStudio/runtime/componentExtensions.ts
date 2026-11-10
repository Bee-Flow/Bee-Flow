/**
 * App Studio runtime: component types added after the base catalog.
 *
 * The 57 base types keep their hand-written entries in componentRegistry.ts. A type added
 * later (componentSpecs/types/<type>.js on the server, `since` >= 3) brings one file here,
 * components/registry/<type>.ts, whose default export is its renderer, palette icon and an
 * editor sample node:
 *
 *   export default { Component: AppGauge, icon: Gauge, sample: { props: { value: 3 } } };
 *
 * The files are found by import.meta.glob and appended after the base types in file-name
 * order, so adding a type never edits a shared list. Label, category and defaults still come
 * from catalogSnapshot.generated.json. The directory ships empty.
 */

import type { ComponentExtension } from './componentRegistry.types';

type ExtensionModules = Record<string, { default: ComponentExtension }>;

/** What the snapshot says about a type: only extensions carry `since`. */
type CatalogTypes = Record<string, { since?: number } | undefined>;

/**
 * The registry files, by path. Vite replaces the glob call at build time; outside Vite (a
 * jest run on the phone side that loads a web runtime file) it does not exist and the
 * registry is empty, which is exactly the base.
 */
function extensionModules(): ExtensionModules {
    try {
        return import.meta.glob<{ default: ComponentExtension }>(['./components/registry/*.ts', '!./components/registry/*.test.ts'], { eager: true });
    } catch {
        return {};
    }
}

export const COMPONENT_EXTENSION_MODULES: ExtensionModules = extensionModules();

function typeOfPath(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return name.endsWith('.ts') ? name.slice(0, -'.ts'.length) : name;
}

function checkExtension(type: string, entry: ComponentExtension | undefined, catalog: CatalogTypes, base: readonly string[]): ComponentExtension {
    const where = `components/registry/${type}.ts`;
    if (base.includes(type)) throw new Error(`${where}: "${type}" is a base type, registered in componentRegistry.ts`);
    const since = catalog[type]?.since;
    if (typeof since !== 'number' || since < 3) throw new Error(`${where}: the catalog has no extension type "${type}" (since >= 3)`);
    if (!entry || !entry.Component || !entry.icon) throw new Error(`${where}: the default export holds Component and icon`);
    if (!entry.sample || typeof entry.sample !== 'object') throw new Error(`${where}: the default export holds an editor sample node`);
    return entry;
}

/** The extension entries of `modules`, keyed by type (the file name), in file-name order. */
export function collectComponentExtensions(modules: ExtensionModules, catalog: CatalogTypes, base: readonly string[]): Record<string, ComponentExtension> {
    const out: Record<string, ComponentExtension> = {};
    for (const file of Object.keys(modules).sort()) {
        const type = typeOfPath(file);
        out[type] = checkExtension(type, modules[file]?.default, catalog, base);
    }
    return out;
}
