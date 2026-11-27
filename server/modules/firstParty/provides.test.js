// @typecheck strict
/**
 * The provides of the first-party modules are what they register, and the core registers
 * the rest. Each module's firstParty/<id>.provides.json (or `provides` of its composition)
 * names the feature modules, integration clients and runner ports its register() fills in
 * (modules/firstParty/registrationChannels.js); the loader declares those names before the
 * module's code runs, so a module that fails never looks absent.
 *
 * Two child processes require boot/featureRegistrations.js the way index.js does: one with
 * every module present, one in core mode (BEEFLOW_HIDE_MODULES=all). Then, per registry:
 *
 *   full minus core      is exactly the union of the modules' provides, each name declared
 *                        by one module (moduleState refuses a second declarer)
 *   every provided name  is registered, and no module is failed
 *
 * The core-mode run also holds what integrations/coreToolsets.js offers with every module
 * hidden: the core's own toolsets (KB search and ingest, web search, browse, regex
 * generator) and group deps (web search availability, office files, memory).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.resolve(__dirname, '..', '..');
const KINDS = /** @type {const} */ (['featureModules', 'integrationClients', 'runnerPorts']);

// Tree paths resolved from the child's cwd (server/), so the scan of relative requires
// (importPaths.test.js) does not read them as requires of this file.
const RECORD = [
    "const load = (p) => require(require('node:path').resolve(p));",
    "load('boot/featureRegistrations');",
    "const { featureModuleNames } = load('core/featureModules');",
    "const { integrationClientNames } = load('core/integrations/integrationClients');",
    "const { runnerPortNames } = load('core/automationRunner/featurePorts');",
    "const { TOOLSETS, GROUP_DEPS } = load('integrations/coreToolsets');",
    "const loader = load('modules/firstParty/loader');",
    "const moduleState = load('modules/firstParty/moduleState');",
    'const names = { featureModules: featureModuleNames(), integrationClients: integrationClientNames(), runnerPorts: runnerPortNames() };',
    'const providers = Object.fromEntries(Object.entries(names).map(([kind, list]) => [kind, Object.fromEntries(list.map((n) => [n, moduleState.providerOf(kind, n)]))]));',
    'const toolsets = Object.entries(TOOLSETS).map(([key, tools]) => [key, tools.length]);',
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ names, providers, modules: loader.modules(), toolsets, groupDeps: Object.keys(GROUP_DEPS) }));",
    'process.exit(0);',
].join('\n');

/**
 * @param {boolean} coreMode
 * @returns {{ names: Record<string, string[]>, providers: Record<string, Record<string, string | null>>,
 *   modules: Array<{ id: string, state: string, detail?: string }>, toolsets: Array<[string, number]>, groupDeps: string[] }}
 */
function record(coreMode) {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, NODE_ENV: 'test' };
    for (const key of ['NODE_OPTIONS', 'BEEFLOW_HIDE_MODULES', 'BEEFLOW_MODULE_ROOTS', 'NODE_TEST_CONTEXT', 'BEEFLOW_EDITION', 'BEEFLOW_MODULES']) delete env[key];
    if (coreMode) env.BEEFLOW_HIDE_MODULES = 'all';
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provides-')), 'out.json');
    const r = spawnSync(process.execPath, ['--require', './moduleRoots.cjs', '-e', RECORD, out], { cwd: SERVER, env, encoding: 'utf8', timeout: 60_000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    return got;
}

const full = record(false);
const core = record(true);

test('every module loaded, and core mode sees none', () => {
    assert.deepStrictEqual(full.modules.filter((m) => m.state !== 'loaded').map((m) => `${m.id}: ${m.detail}`), []);
    assert.deepStrictEqual(core.modules, []);
});

for (const kind of KINDS) {
    test(`${kind}: what the modules add is what they provide, and each provided name is registered`, () => {
        const coreNames = new Set(core.names[kind]);
        const added = full.names[kind].filter((n) => !coreNames.has(n)).sort();
        const provided = Object.entries(full.providers[kind]).filter(([, owner]) => owner !== null).map(([n]) => n).sort();
        assert.deepStrictEqual(added, provided, `${kind}: a module registers a name it does not provide, or the reverse`);
        assert.deepStrictEqual(core.names[kind].filter((n) => full.providers[kind][n] !== null), [], `${kind}: a core name is declared by a module`);
    });
}

test('core mode: integrations/coreToolsets.js offers the core tools', () => {
    assert.deepStrictEqual(core.toolsets.map(([key]) => key), ['AGENT_SEARCH_TOOLS', 'BROWSE_WEB_TOOLS', 'REGEX_GENERATOR_TOOLS', 'KB_SEARCH_TOOLS', 'KB_INGEST_TOOLS']);
    for (const [key, count] of core.toolsets) assert.ok(count > 0, `${key} is empty`);
    assert.deepStrictEqual(core.groupDeps, ['webSearchAvailability', 'officeFileDelivery', 'memoryTools']);
    const fullCounts = new Map(full.toolsets);
    for (const [key, count] of core.toolsets) assert.strictEqual(count, fullCounts.get(key), `${key}: a different array with every module present`);
});
