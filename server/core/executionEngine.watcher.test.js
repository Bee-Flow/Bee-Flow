// @typecheck
/**
 * The watcher trigger compares the current items with the state of the previous
 * poll. getWatcherState is async; it used to be read without await, so the
 * previous state was always empty and every poll reported every item as added.
 *
 * Run: node --test core/executionEngine.watcher.test.js
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const componentManager = require('./cms/componentManager');
const watcherStateStore = require('../stores/watcherStateStore');
const { executeWorkflow } = require('./executionEngine');

let root;
let useOdd = false;
let dirs;
const origGetPath = componentManager.getComponentPath;
const origGet = watcherStateStore.getWatcherState;
const origSave = watcherStateStore.saveWatcherState;

function component(name, source) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return dir;
}

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
    dirs = {
        'trigger-watcher': component('trigger', `
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: { config: { componentId: 'lister', componentInputs: {} } } })));
`),
        lister: component('lister', `
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: { files: [
  { id: 'a', modified: 1 }, { id: 'b', modified: 2 }, { id: 'c', modified: 3 } ] } })));
`),
        'trigger-odd': component('trigger-odd', `
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ result: { config: { componentId: 'odd-lister', componentInputs: {} } } })));
`),
        'odd-lister': component('odd-lister', `
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write('{"result":{"files":[{"id":"constructor","modified":1},{"id":"__proto__","modified":2},{"id":"toString","modified":3}]}}'));
`),
    };
    componentManager.getComponentPath = (id) => dirs[id === 'trigger-watcher' && useOdd ? 'trigger-odd' : id] || null;
});

after(() => {
    componentManager.getComponentPath = origGetPath;
    watcherStateStore.getWatcherState = origGet;
    watcherStateStore.saveWatcherState = origSave;
    fs.rmSync(root, { recursive: true, force: true });
});

test('unchanged items from a stored (async) previous state are not reported as added', async () => {
    let saved = null;
    watcherStateStore.getWatcherState = async () => ({
        items: {
            a: { modified: 1, data: { id: 'a', modified: 1 } },
            b: { modified: 2, data: { id: 'b', modified: 2 } },
            c: { modified: 3, data: { id: 'c', modified: 3 } },
        },
        lastCheck: 'x',
    });
    watcherStateStore.saveWatcherState = async (_id, items) => { saved = items; };

    const out = await executeWorkflow({
        nodes: [{ id: 'n1', type: 'trigger-watcher', data: {} }],
        edges: [],
    });

    assert.deepEqual(out.n1.result.addedItems, []);
    assert.deepEqual(out.n1.result.modifiedItems, []);
    assert.equal(out.n1.result.hasChanges, false);
    assert.equal(out.n1.result.previousItems.length, 3);
    assert.deepEqual(Object.keys(saved), ['a', 'b', 'c']);
});

test('an item whose id is a name on Object.prototype is a new item like any other, and is kept in the state', async () => {
    let saved = null;
    watcherStateStore.getWatcherState = async () => null;
    watcherStateStore.saveWatcherState = async (_id, items) => { saved = JSON.parse(JSON.stringify(items)); };
    useOdd = true;
    try {
        const out = await executeWorkflow({ nodes: [{ id: 'n1', type: 'trigger-watcher', data: {} }], edges: [] });
        assert.deepEqual(out.n1.result.addedItems.map((i) => i.id), ['constructor', '__proto__', 'toString']);
        assert.deepEqual(out.n1.result.modifiedItems, []);
        assert.deepEqual(Object.keys(saved), ['constructor', '__proto__', 'toString']);
    } finally { useOdd = false; }
});

test('a node without a data object runs with no inputs of its own', async () => {
    watcherStateStore.getWatcherState = async () => null;
    watcherStateStore.saveWatcherState = async () => {};
    const out = await executeWorkflow({ nodes: [{ id: 'n1', type: 'lister' }], edges: [] });
    assert.equal(out.n1.result.files.length, 3);
});
