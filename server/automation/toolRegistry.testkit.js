// @typecheck
'use strict';
/**
 * The checks every inline tool app of automation/toolRegistry.js answers to. toolRegistry.test.js
 * runs them for the core's inline apps; the notebooks module's app (`workspace`, its tools are
 * the notebooks module's integrations/workspaceTools) answers to them in
 * toolRegistry.notebooks.test.js, which that module owns.
 */

const assert = require('node:assert');
const { loadTools } = require('./toolRegistry');

/** The inline app whose tools the notebooks module holds. */
const NOTEBOOKS_INLINE_APP = 'workspace';

/**
 * An inline app loads real tools, has to be granted explicitly, and says why it can be missing.
 * @param {{ app: string, module: string, arrayName: string, grantsRequireEntry?: boolean, availability?: string | string[] }} entry
 */
function assertInlineApp(entry) {
    const tools = loadTools(entry);
    assert.ok(tools.length > 0, `${entry.app}: ${entry.module}.${entry.arrayName} laadt niets`);
    for (const t of tools) {
        assert.strictEqual(typeof t?.function?.name, 'string', `${entry.app}: tool zonder naam`);
    }
    // Silence about an inline app is not a choice: the picker never showed it, so nobody can have left it
    // standing. See toolPolicy.js.
    assert.strictEqual(entry.grantsRequireEntry, true,
        `${entry.app}: een inline app moet expliciet gegund worden`);
    // "Afwezig op deze installatie" is something different from "jij hebt hem niet verbonden". The picker must
    // be able to say that difference — and where an app sits behind SEVERAL gates (the browser: docker probe
    // AND org entitlement; the notebooks: feature flag, entitlement and `use_notebooks`) they are listed both,
    // because naming one of them is a claim that the measurement does not yield.
    const kinds = Array.isArray(entry.availability) ? entry.availability : [entry.availability];
    assert.ok(kinds.length > 0, `${entry.app}: availability moet zeggen WAAROM een app kan ontbreken`);
    for (const kind of kinds) {
        assert.ok(['installation', 'connection', 'permission'].includes(/** @type {string} */ (kind)),
            `${entry.app}: onbekende availability "${kind}"`);
    }
    assert.strictEqual(new Set(kinds).size, kinds.length, `${entry.app}: dubbele availability`);
}

module.exports = { assertInlineApp, NOTEBOOKS_INLINE_APP };
