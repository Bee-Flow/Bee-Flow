/**
 * Blueprint install and the definition gate (appStudio/definitionGate.mts): an
 * app is stored and stamped as the Blueprint carries it, an app this
 * installation must not store is skipped, and validator errors ride along on
 * the installed entry.
 *
 * Run: cd server && node --test projects/packaging/install.definitionGate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { reset, called, install } = require('./installTestHarness');
const { installApps } = require('./install/parts/apps');
const { emptyDefinition, SCHEMA_VERSION_CURRENT } = require('../../appStudio/componentSpecs');


/** installApps with a recording context: the part under test, without the manifest reader in front of it. */
async function runInstallApps(entities) {
    const stamps = [];
    const report = { installed: { apps: [] }, skipped: [], warnings: [] };
    const ctx = {
        can: () => true, ownerId: 'installer', organizationId: 'org1', projectId: 'proj_new', refMap: new Map(),
        stamp: async (s) => { stamps.push(s); },
    };
    await installApps(entities, ctx, report);
    return { report, stamps };
}

test('a valid app installs with no findings, stored and stamped as given', async () => {
    reset();
    const definition = emptyDefinition('Desk');
    const before = JSON.stringify(definition);
    const { report, stamps } = await runInstallApps([{ ref: 'app_1', name: 'Desk', definition }]);
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(Object.keys(report.installed.apps[0]), ['ref', 'id', 'name']);
    assert.strictEqual(JSON.stringify(called('createStudioApp')[0].args.definition), before);
    assert.strictEqual(stamps[0].payload, definition, 'the stamp hashes the payload as written');
    assert.strictEqual(JSON.stringify(definition), before);
});

test('an app with validator errors still installs, byte for byte, with the errors on its entry', async () => {
    reset();
    const definition = { actions: {} };
    const { report, stamps } = await runInstallApps([{ ref: 'app_1', name: 'Desk', definition }]);
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(called('createStudioApp')[0].args.definition, { actions: {} });
    assert.deepStrictEqual(stamps[0].payload, { actions: {} });
    const [entry] = report.installed.apps;
    assert.ok(entry.findings.errors.some((e) => e.code === 'screens.missing'), JSON.stringify(entry.findings));
});

test('an app written by a newer installation is skipped and nothing is created or stamped', async () => {
    reset();
    const newer = { ...emptyDefinition('Later'), schemaVersion: SCHEMA_VERSION_CURRENT + 1 };
    const { report, stamps } = await runInstallApps([
        { ref: 'app_1', name: 'Later', definition: newer },
        { ref: 'app_2', name: 'Now', definition: emptyDefinition('Now') },
    ]);
    assert.deepStrictEqual(report.skipped.map((s) => [s.ref, s.kind]), [['app_1', 'app']]);
    assert.match(report.skipped[0].why, /newer version/);
    assert.deepStrictEqual(report.installed.apps.map((a) => a.ref), ['app_2'], 'one refused app does not stop the next');
    assert.strictEqual(called('createStudioApp').length, 1);
    assert.deepStrictEqual(stamps.map((s) => s.ref), ['app_2']);
});

test('an app whose definition is not an object is skipped', async () => {
    reset();
    const { report } = await runInstallApps([{ ref: 'app_1', name: 'Broken', definition: 'nope' }]);
    assert.deepStrictEqual(report.skipped.map((s) => s.ref), ['app_1']);
    assert.strictEqual(called('createStudioApp').length, 0);
});

test('an app without a definition still installs with the store default, as before the gate', async () => {
    reset();
    const { report, stamps } = await runInstallApps([{ ref: 'app_1', name: 'Bare' }]);
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(Object.keys(report.installed.apps[0]), ['ref', 'id', 'name']);
    assert.strictEqual(called('createStudioApp').length, 1);
    assert.strictEqual(stamps[0].payload, undefined);
});

test('uploaded files and triggers: the app installs byte for byte, unpublished (nothing armed), and the report says what did not travel', async () => {
    reset();
    const definition = {
        ...emptyDefinition('Desk'), schemaVersion: 3,
        design: { logoUrl: 'asset:0b6f2c1e-4a8d-4e1f-9c3b-1d2e3f4a5b6c' },
        actions: { act_in: { steps: [] } },
        triggers: [{ id: 'hook', kind: 'webhook', actionId: 'act_in', auth: 'hmac' }],
    };
    const before = JSON.stringify(definition);
    const { report } = await runInstallApps([{ ref: 'app_1', name: 'Desk', definition }]);
    // The harness store has no publish: an install that published (and so armed) would land in skipped.
    assert.deepStrictEqual(report.skipped, []);
    assert.strictEqual(JSON.stringify(called('createStudioApp')[0].args.definition), before);
    assert.match(report.warnings.join(' '), /"Desk" uses 1 uploaded file\(s\).*do not travel/);
    assert.match(report.warnings.join(' '), /1 trigger\(s\); they start only once the app is published\. 1 webhook trigger\(s\) get a new address and secret/);
});

test('through installBlueprint: the report carries the findings of an app that has errors', async () => {
    reset();
    const result = await install({ apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: {} } }] });
    assert.strictEqual(result.ok, true);
    assert.ok(result.report.installed.apps[0].findings.errors.length > 0);
});
