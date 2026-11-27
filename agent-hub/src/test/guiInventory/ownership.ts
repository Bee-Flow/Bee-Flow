/**
 * Tree paths and owners for the GUI inventory: where a web file is (over every
 * root: agent-hub/ and each modules/<id>/frontend/, scripts/lib/roots.mjs) and
 * which first-party module owns it (scripts/module-map.mjs, package
 * `agent-hub`; `core` when no module does).
 *
 * Both are repository scripts (node:* only, synchronous), loaded with Node's own
 * require so the test runner does not transform them.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
/** The repository root: this file is agent-hub/src/test/guiInventory/ownership.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

interface RootsHelper {
    resolveTreePath: (pkg: string, treePath: string) => string | null;
    locate: (abs: string) => { pkg: string; treePath: string; moduleId: string | null } | null;
}
interface ModuleMap {
    ownerOf: (pkg: string, treePath: string) => string | null;
}

let roots: RootsHelper | null = null;
let map: ModuleMap | null = null;

function rootsHelper(): RootsHelper {
    roots ??= nodeRequire(path.join(REPO_ROOT, 'scripts', 'lib', 'roots.mjs')) as RootsHelper;
    return roots;
}

function moduleMap(): ModuleMap {
    map ??= (nodeRequire(path.join(REPO_ROOT, 'scripts', 'module-map.mjs')) as { loadModuleMap: () => ModuleMap }).loadModuleMap();
    return map;
}

/** The absolute path of a web tree path (`src/...`) in the first root that has it, or null. */
export function webFile(treePath: string): string | null {
    return rootsHelper().resolveTreePath('agent-hub', treePath);
}

/** The tree path of an absolute web file (`src/...`), whichever root it is in; null outside the web roots. */
export function webTreePath(abs: string): string | null {
    const at = rootsHelper().locate(abs);
    return at && at.pkg === 'agent-hub' ? at.treePath : null;
}

/** The owner of a web tree path: a module id, or `core`. */
export function ownerOf(treePath: string): string {
    const at = webFile(treePath);
    const moved = at ? rootsHelper().locate(at)?.moduleId : null;
    return moved ?? moduleMap().ownerOf('agent-hub', treePath) ?? 'core';
}

/** One owner when the files agree, else every owner (sorted); null without a file. */
export function ownersOf(treePaths: readonly (string | null | undefined)[]): string | string[] | null {
    const owners = [...new Set(treePaths.filter((p): p is string => !!p).map(ownerOf))].sort();
    if (!owners.length) return null;
    return owners.length === 1 ? owners[0] : owners;
}
