/**
 * A rewrite of component.json keeps the owner the component was created with.
 *
 * `owner` in component.json decides which organisation may list and call a
 * component (componentVisibleTo, core/agentRuntime/agentTools.js). It is set
 * once, by POST /ai/create-component. The designer's `update_component` tool
 * writes whole files through updateComponent, component.json included, so
 * without this a rewrite could drop the owner (the component is offered to
 * every org again) or name another org (the code lands in that org's
 * catalogue).
 *
 * updateComponent writes into the real components/ directory (a module
 * constant), so the test works on a probe directory there and removes it.
 *
 * Run: cd server && node --test core/cms/componentManager.owner.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const componentManager = require('./componentManager');

const PROBE_ID = 'zz-component-owner-probe';
const PROBE_DIR = path.join(componentManager.COMPONENTS_DIR, PROBE_ID);
const SPEC = path.join(PROBE_DIR, 'component.json');

function makeProbe(definition) {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(SPEC, JSON.stringify(definition, null, 2));
    fs.writeFileSync(path.join(PROBE_DIR, 'package.json'), JSON.stringify({ name: PROBE_ID, version: '1.0.0', dependencies: {} }));
    fs.writeFileSync(path.join(PROBE_DIR, 'index.js'), 'module.exports = 1;\n');
}
const readSpec = () => JSON.parse(fs.readFileSync(SPEC, 'utf8'));

test.afterEach(() => {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    componentManager.removeComponent(PROBE_ID);
});

test('a rewrite that drops the owner keeps it', async () => {
    makeProbe({ name: 'Probe', agentEnabled: true, owner: { orgId: 'org-a' } });
    await componentManager.updateComponent(PROBE_ID, {
        'component.json': JSON.stringify({ name: 'Probe v2', agentEnabled: true }),
    });
    const spec = readSpec();
    assert.strictEqual(spec.name, 'Probe v2', 'the rest of the rewrite still lands');
    assert.deepStrictEqual(spec.owner, { orgId: 'org-a' },
        'without the owner the component is offered to every organisation again');
    const loaded = componentManager.getComponents().find(c => c.id === PROBE_ID);
    assert.deepStrictEqual(loaded.definition.owner, { orgId: 'org-a' }, 'and the in-memory definition agrees');
});

test('a rewrite that names another org keeps the original one', async () => {
    makeProbe({ name: 'Probe', agentEnabled: true, owner: { orgId: 'org-a' } });
    await componentManager.updateComponent(PROBE_ID, {
        'component.json': JSON.stringify({ name: 'Probe', agentEnabled: true, owner: { orgId: 'org-b' } }),
    });
    assert.deepStrictEqual(readSpec().owner, { orgId: 'org-a' });
});

test('an unowned component cannot be given an owner by a rewrite either', async () => {
    makeProbe({ name: 'Shipped', agentEnabled: true });
    await componentManager.updateComponent(PROBE_ID, {
        'component.json': JSON.stringify({ name: 'Shipped', agentEnabled: true, owner: { orgId: 'org-b' } }),
    });
    assert.strictEqual(readSpec().owner, undefined);
});

test('a rewrite of another file leaves component.json alone', async () => {
    makeProbe({ name: 'Probe', agentEnabled: true, owner: { userId: 'u1' } });
    await componentManager.updateComponent(PROBE_ID, { 'index.js': 'module.exports = 2;\n' });
    assert.deepStrictEqual(readSpec().owner, { userId: 'u1' });
});
