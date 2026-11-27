'use strict';
/**
 * modules/firstParty/moduleData.js: the six rows of the data-duty table, with a state double, a
 * ledger double and a tree double (no database), plus the caching and the "cannot tell" answers.
 *
 * Run: cd server && node --test modules/firstParty/moduleData.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    moduleForDataDuty, hasSchemaOf, unitsOf, ModuleDataPresentError,
    _setModuleDataDepsForTests, _resetModuleDataForTests,
} = require('./moduleData');
const { ModuleFailedError } = require('./moduleState');

const NAME = /** @type {any} */ ('stores/complianceStore');
const REFUSE = { duty: 'erase the compliance hints of an account', whenDataPresent: /** @type {const} */ ('refuse') };
const WARN = { duty: 'prune old compliance events', whenDataPresent: /** @type {const} */ ('warn') };
const FROM_REGISTRY = { from: 'registry' };
const FROM_TREE = { from: 'tree' };

/**
 * A world: the module's state, whether its file is in the tree, whether the ledger holds one
 * of its units (or throws), and what was asked.
 * @param {{ state?: string, inTree?: boolean, schema?: boolean | 'throws', noLedger?: boolean, registry?: false }} w
 *   registry false: the registry does not know the name (it was never filled, or the name is not declared)
 */
function world(w) {
    const seen = { queries: 0, warnings: /** @type {string[]} */ ([]), lookups: 0 };
    _setModuleDataDepsForTests({
        state: () => w.state || 'absent',
        lookup: () => {
            seen.lookups++;
            if (w.registry === false) return null;
            if (w.state === 'failed') throw new ModuleFailedError('compliance', 'featureModules', NAME, 'boom');
            return w.state === 'loaded' ? FROM_REGISTRY : null;
        },
        treeModule: () => (w.inTree ? FROM_TREE : null),
        ledgerQuery: () => (w.noLedger ? null : async (/** @type {string} */ sql) => {
            seen.queries++;
            if (w.schema === 'throws') throw new Error('connection refused');
            if (/to_regclass/.test(sql)) return { rows: [{ present: true }] };
            return { rows: w.schema ? [{ present: 1 }] : [] };
        }),
        log: () => /** @type {any} */ ({ warn: (/** @type {string} */ m) => seen.warnings.push(m) }),
    });
    return seen;
}

beforeEach(() => _resetModuleDataForTests());
after(() => _resetModuleDataForTests());

test('row 1, loaded: the registry answers, as today; the ledger is not asked', async () => {
    const seen = world({ state: 'loaded', inTree: true, schema: true });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), FROM_REGISTRY);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), FROM_REGISTRY);
    assert.equal(seen.queries, 0);
});

test('row 2, failed: the lookup throws ModuleFailedError, for erasure and retention alike', async () => {
    world({ state: 'failed', inTree: true, schema: true });
    await assert.rejects(moduleForDataDuty('compliance', NAME, REFUSE), ModuleFailedError);
    await assert.rejects(moduleForDataDuty('compliance', NAME, WARN), ModuleFailedError);
});

test('a present module is never skipped: the file itself when the registry does not know the name, an error without one', async () => {
    const seen = world({ state: 'loaded', inTree: true, registry: false });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), FROM_TREE);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), FROM_TREE);
    assert.equal(seen.queries, 0);
    world({ state: 'loaded', inTree: false, registry: false });
    await assert.rejects(moduleForDataDuty('compliance', NAME, WARN), /module "compliance" is loaded but has no file "stores\/complianceStore"/);
    world({ state: 'failed', inTree: true, registry: false });
    await assert.rejects(moduleForDataDuty('compliance', NAME, REFUSE), ModuleFailedError);
});

test('row 3, absent, file in the tree, schema held: the duty runs with the module file', async () => {
    world({ inTree: true, schema: true });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), FROM_TREE);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), FROM_TREE);
});

test('a name the registry holds is the answer whatever the state says: a test double of an absent module', async () => {
    const seen = world({ inTree: false, schema: true });
    const double = { double: true };
    _setModuleDataDepsForTests({ lookup: () => double, state: () => 'absent' });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), double);
    assert.equal(seen.queries, 0);
});

test('row 4, absent, file in the tree, no schema: skipped (null), nothing of the module is loaded', async () => {
    world({ inTree: true, schema: false });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), null);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), null);
});

test('row 5, absent, no file, no schema: skipped', async () => {
    const seen = world({ inTree: false, schema: false });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), null);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), null);
    assert.deepEqual(seen.warnings, []);
});

test('row 6, absent, no file, schema held: erasure refuses; retention is skipped with one warning', async () => {
    const seen = world({ inTree: false, schema: true });
    await assert.rejects(moduleForDataDuty('compliance', NAME, REFUSE), (/** @type {any} */ err) => {
        assert.ok(err instanceof ModuleDataPresentError);
        assert.equal(err.code, 'MODULE_DATA_PRESENT');
        assert.equal(err.moduleId, 'compliance');
        assert.equal(err.duty, REFUSE.duty);
        assert.equal(err.message, 'module "compliance" is not installed but this database holds its data; '
            + 'refusing to erase the compliance hints of an account. Install the module or remove its data first.');
        return true;
    });
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), null);
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), null);
    assert.equal(seen.warnings.length, 1, 'one warning per process and duty');
    assert.match(seen.warnings[0], /module "compliance".*prune old compliance events/);
});

test('cannot tell (the ledger throws): refuse runs the file when it is there and refuses when not; warn warns', async () => {
    world({ inTree: true, schema: 'throws' });
    assert.equal(await moduleForDataDuty('compliance', NAME, REFUSE), FROM_TREE);
    world({ inTree: false, schema: 'throws' });
    await assert.rejects(moduleForDataDuty('compliance', NAME, REFUSE), ModuleDataPresentError);
    const seen = world({ inTree: true, schema: 'throws' });
    assert.equal(await moduleForDataDuty('compliance', NAME, WARN), null);
    assert.equal(seen.warnings.length, 1);
});

test('no ledger (a db facade without ledgerQuery) and a module without units hold no schema', async () => {
    world({ noLedger: true });
    assert.equal(await hasSchemaOf('compliance'), false);
    const seen = world({ schema: true });
    assert.deepEqual(unitsOf('notebooks'), []);
    assert.equal(await hasSchemaOf('notebooks'), false);
    assert.equal(seen.queries, 0);
});

test('a held schema is remembered; "not held" only briefly', async () => {
    let now = 1_000_000;
    const seen = world({ schema: false });
    _setModuleDataDepsForTests({ now: () => now });
    assert.equal(await hasSchemaOf('compliance'), false);
    const asked = seen.queries;
    assert.equal(await hasSchemaOf('compliance'), false);
    assert.equal(seen.queries, asked, 'a negative answer is cached for a short while');
    now += 60_000;
    await hasSchemaOf('compliance');
    assert.ok(seen.queries > asked, 'and asked again after it');
});

test('whenDataPresent is required', async () => {
    world({});
    await assert.rejects(moduleForDataDuty('compliance', NAME, /** @type {any} */ ({ duty: 'x' })), TypeError);
});

test('the real sources: a file of the tree is required by its tree path; the registry is read once it is loaded', async () => {
    _setModuleDataDepsForTests({
        state: () => 'absent',
        ledgerQuery: () => async () => ({ rows: [{ present: true }] }),
        log: () => /** @type {any} */ ({ warn() {} }),
    });
    const hidden = (process.env.BEEFLOW_HIDE_MODULES || '') !== '';
    const store = await moduleForDataDuty('compliance', NAME, WARN);
    assert.equal(store, hidden ? null : require('../../stores/complianceStore'));
    const registry = require('../../core/featureModules');
    const stub = { stub: true };
    registry.registerFeatureModules({ 'tests/moduleDataProbe': () => stub });
    try {
        _setModuleDataDepsForTests({ state: () => 'loaded' });
        assert.equal(await moduleForDataDuty('compliance', /** @type {any} */ ('tests/moduleDataProbe'), REFUSE), stub);
    } finally {
        registry._clearFeatureModulesForTests('tests/moduleDataProbe');
    }
});

/**
 * What a process that loaded nothing but the resolver answers for one name: through the stores'
 * lookup (no registry loaded) and through the core's (a registry nothing has filled yet).
 * @param {Record<string, string>} edition
 */
function bareProcess(edition) {
    const code = [
        'const fromStores = require(process.argv[1]).lookupFeatureModule("compliance/events");',
        'const fromCore = require(process.argv[2]).optionalFeatureModule("compliance/events");',
        'process.stdout.write(JSON.stringify({ fromStores: fromStores && Object.keys(fromStores).length > 0, fromCore: fromCore && Object.keys(fromCore).length > 0 }));',
    ].join('\n');
    const SERVER = path.join(__dirname, '..', '..');
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, ...edition };
    for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[key];
    for (const key of ['BEEFLOW_HIDE_MODULES', 'BEEFLOW_EDITION', 'BEEFLOW_MODULES']) if (!(key in edition)) delete env[key];
    const r = spawnSync(process.execPath, ['--require', path.join(SERVER, 'moduleRoots.cjs'), '-e', code,
        path.join(__dirname, 'moduleData.js'), path.join(SERVER, 'core', 'featureModules.js')], { cwd: SERVER, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    // Under an edition the loader logs one "[modules] edition: ..." line first (the dev log writes to stdout).
    return JSON.parse(/** @type {string} */ (r.stdout.trim().split('\n').pop()));
}

test('the answer does not depend on the entry point: a bare process sees a loaded module, and an absent one as absent', () => {
    assert.deepEqual(bareProcess({}), { fromStores: true, fromCore: true });
    assert.deepEqual(bareProcess({ BEEFLOW_EDITION: 'core' }), { fromStores: null, fromCore: null });
    assert.deepEqual(bareProcess({ BEEFLOW_HIDE_MODULES: 'all' }), { fromStores: null, fromCore: null });
});

test('moduleDataHere: a present module yes without asking the ledger; an absent one by its schema; an unreadable ledger yes', async () => {
    const { moduleDataHere } = require('./moduleData');
    let seen = world({ state: 'loaded', schema: false });
    assert.equal(await moduleDataHere('compliance'), true);
    assert.equal(seen.queries, 0);
    world({ state: 'failed', schema: false });
    assert.equal(await moduleDataHere('compliance'), true);
    world({ state: 'absent', schema: true });
    assert.equal(await moduleDataHere('compliance'), true);
    world({ state: 'absent', schema: false });
    assert.equal(await moduleDataHere('compliance'), false);
    world({ state: 'absent', noLedger: true });
    assert.equal(await moduleDataHere('compliance'), false);
    seen = world({ state: 'absent', schema: 'throws' });
    assert.equal(await moduleDataHere('compliance'), true, 'cannot tell: the statement runs (fail closed)');
    assert.equal(seen.warnings.length, 0);
});
