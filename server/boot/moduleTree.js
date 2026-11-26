// @typecheck strict
/**
 * Start-up check of the module tree: every tree path lives in exactly one root (server/
 * or one modules/<id>/server/). When two roots hold the same tree path, which file a
 * require lands on depends on who asks, so the server refuses to start instead of running
 * on a tree it cannot reason about. Inert while no module directory exists (nothing to walk).
 * The rule itself is modules/roots/treeCheck.cjs; server/index.js calls this once, early.
 */

'use strict';

/** How many offending tree paths the error line names. */
const MAX_NAMED = 10;

/** @typedef {{ treePath: string, roots: (string | null)[] }} Clash */

/**
 * The one error line for a list of clashes.
 * @param {Clash[]} clashes non-empty
 */
function describeClashes(clashes) {
    const named = [...new Set(clashes.map((c) => c.treePath))];
    const shown = named.slice(0, MAX_NAMED).join(', ');
    const more = named.length > MAX_NAMED ? ` and ${named.length - MAX_NAMED} more` : '';
    return `[Server] FATAL: ${named.length} tree path(s) exist in more than one module root, so a require `
        + `would land on a different file depending on who asks: ${shown}${more}. `
        + 'Every tree path must live in exactly one of server/ and modules/<id>/server/. Refusing to start.';
}

/**
 * Stop the process when the tree is not sound.
 * @param {{
 *   duplicates?: () => Clash[],
 *   log?: { error: (msg: string) => void },
 *   exit?: (code: number) => void,
 * }} [deps] injected in tests; default: the resolver's check, the server logger, process.exit
 * @returns {boolean} true when the tree is sound
 */
function assertSoundModuleTree(deps = {}) {
    const duplicates = deps.duplicates ?? require('../moduleRoots.cjs').duplicateTreePaths;
    const clashes = duplicates();
    if (clashes.length === 0) return true;
    const log = deps.log ?? require('../telemetry/log');
    log.error(describeClashes(clashes));
    (deps.exit ?? ((code) => process.exit(code)))(1);
    return false;
}

module.exports = { assertSoundModuleTree, describeClashes, MAX_NAMED };
