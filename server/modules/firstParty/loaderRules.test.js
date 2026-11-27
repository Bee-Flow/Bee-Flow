/**
 * modules/firstParty/loaderRules.js: the composition contract checks, the requires order, the
 * order-index sort, and the two stateless run steps (one job, one bounded shutdown hook).
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const rules = require('./loaderRules');

const handlers = () => [() => {}];

/** A log that records its calls. */
function recordingLog() {
    /** @type {Array<[string, unknown[]]>} */
    const calls = [];
    const at = (/** @type {string} */ level) => (/** @type {unknown[]} */ ...args) => { calls.push([level, args]); };
    return { calls, info: at('info'), warn: at('warn'), error: at('error') };
}

describe('STARTUP_PHASE_NAMES', () => {
    test('equals the function names of boot/startupTasks.js STARTUP_PHASES, in order', () => {
        const { STARTUP_PHASES } = require('../../boot/startupTasks');
        assert.deepStrictEqual([...rules.STARTUP_PHASE_NAMES], STARTUP_PHASES.map((/** @type {Function} */ f) => f.name));
    });
});

describe('compositionProblem', () => {
    test('a minimal composition and a full one pass', () => {
        assert.strictEqual(rules.compositionProblem({ id: 'm1' }, 'm1'), null);
        assert.strictEqual(rules.compositionProblem({
            id: 'm1', requires: ['m2'], uses: ['m3'], provides: { featureModules: ['a'], runnerPorts: [] },
            mounts: [{ key: 'm1:/api/x', slot: 'main', path: '/api/x', handlers, when: () => true, onMount: () => {} }],
            aiMounts: [{ key: 'm1:ai', path: null, handlers }],
            jobs: [{ key: 'm1:tick', phase: 'startRunnersAndFeeds', start: () => {}, label: 'Tick', failText: 'start failed' }],
            register() {}, afterListen() {}, async drain() {}, async close() {},
            stores: [{ name: 'm1Store', file: './stores/m1Store' }], migrations: ['mig-1'], nlTranslations: ['add-nl-m1'],
        }, 'm1'), null);
    });

    const cases = [
        ['not an object', 'x', /does not export an object/],
        ['an id that is not the file name', { id: 'm2' }, /is not the file name "m1"/],
        ['a require of itself', { id: 'm1', requires: ['m1'] }, /requires itself/],
        ['an unknown key', { id: 'm1', mount: [] }, /unknown key "mount"/],
        ['requires that is no list of names', { id: 'm1', requires: 'm2' }, /requires is a list of names/],
        ['a register that is no function', { id: 'm1', register: {} }, /register is a function/],
        ['an unknown provides kind', { id: 'm1', provides: { routes: [] } }, /provides.routes is not one of/],
        ['a mount key without the module prefix', { id: 'm1', mounts: [{ key: 'x', slot: 'main', path: '/x', handlers }] }, /mounts\[0\]: key "x"/],
        ['an unknown slot', { id: 'm1', mounts: [{ key: 'm1:x', slot: 'late', path: '/x', handlers }] }, /slot "late"/],
        ['a mount without handlers', { id: 'm1', mounts: [{ key: 'm1:x', slot: 'main', path: '/x' }] }, /handlers is a function/],
        ['an empty path', { id: 'm1', mounts: [{ key: 'm1:x', slot: 'main', path: '', handlers }] }, /path is a non-empty string or null/],
        ['an unknown phase', { id: 'm1', jobs: [{ key: 'm1:j', phase: 'startLater', start: () => {} }] }, /jobs\[0\]: phase "startLater"/],
        ['a store row without file', { id: 'm1', stores: [{ name: 's' }] }, /stores\[0\]/],
    ];
    for (const [what, comp, expected] of cases) {
        test(`refuses ${what}`, () => {
            assert.match(String(rules.compositionProblem(comp, 'm1')), /** @type {RegExp} */ (expected));
        });
    }

    test('an aiMounts row needs no slot', () => {
        assert.strictEqual(rules.compositionProblem({ id: 'm1', aiMounts: [{ key: 'm1:a', path: '/a', handlers }] }, 'm1'), null);
    });
});

describe('duplicateKeys', () => {
    test('a key that an earlier module claimed (mounts, aiMounts and jobs share one key space)', () => {
        const clashes = rules.duplicateKeys([
            { id: 'a', mounts: [{ key: 'a:x', slot: 'main', path: '/x', handlers }] },
            { id: 'b', jobs: [{ key: 'a:x', phase: 'startSeatSync', start: () => {} }] },
            { id: 'c', aiMounts: [{ key: 'c:y', path: null, handlers }] },
        ]);
        assert.deepStrictEqual([...clashes], [['b', { key: 'a:x', owner: 'a' }]]);
    });
});

describe('requiresOrder', () => {
    test('a module comes after what it requires, ties by id; a cycle is reported; unknown requires are ignored', () => {
        const got = rules.requiresOrder(new Map([
            ['playbooks', ['apps', 'automation']], ['apps', ['automation', 'datatables']], ['automation', ['datatables']],
            ['datatables', []], ['cms', ['gone']], ['x', ['y']], ['y', ['x']],
        ]));
        assert.deepStrictEqual(got, { order: ['cms', 'datatables', 'automation', 'apps', 'playbooks'], cyclic: ['x', 'y'] });
    });
});

describe('orderRows', () => {
    test('listed names by position, then the unlisted ones by module id and row order', () => {
        const items = [
            { moduleId: 'b', index: 0, name: 'b1', row: 'b1' },
            { moduleId: 'a', index: 1, name: 'a2', row: 'a2' },
            { moduleId: 'a', index: 0, name: 'a1', row: 'a1' },
            { moduleId: 'c', index: 0, name: 'c1', row: 'c1' },
            { moduleId: 'b', index: 1, name: 'b2', row: 'b2' },
        ];
        assert.deepStrictEqual(rules.orderRows(items, ['c1', 'b2', 'nobody']), ['c1', 'b2', 'a1', 'a2', 'b1']);
    });
});

describe('startJob', () => {
    test('a throw is logged in the boot/startupJobs.js shape, with the label and failText', () => {
        const log = recordingLog();
        rules.startJob(log, { key: 'm1:sync', phase: 'startSeatSync', start: () => { throw new Error('boom'); } }, undefined);
        rules.startJob(log, { key: 'm1:sync', phase: 'startSeatSync', label: 'Seat sync', failText: 'start failed', start: () => { throw new Error('bang'); } }, undefined);
        assert.deepStrictEqual(log.calls, [
            ['warn', ['[Server] m1:sync load failed:', 'boom']],
            ['warn', ['[Server] Seat sync start failed:', 'bang']],
        ]);
    });

    test('start gets the context; a rejected promise is logged as a start error', async () => {
        const log = recordingLog();
        /** @type {unknown[]} */
        const seen = [];
        rules.startJob(log, { key: 'm1:r', phase: 'startSeatSync', label: 'Runner', start: (ctx) => { seen.push(ctx); return Promise.reject(new Error('no db')); } }, { k: 1 });
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(seen, [{ k: 1 }]);
        assert.deepStrictEqual(log.calls, [['warn', ['[Server] Runner start error:', 'no db']]]);
    });
});

describe('runBounded', () => {
    test('passes the time-out, logs a throw, and gives up after timeoutMs without rejecting', async () => {
        const log = recordingLog();
        /** @type {unknown[]} */
        const opts = [];
        await rules.runBounded(log, 'module a drain', async (o) => { opts.push(o); }, 50);
        await rules.runBounded(log, 'module b drain', () => { throw new Error('sync throw'); }, 50);
        await rules.runBounded(log, 'module c drain', () => Promise.reject(new Error('rejected')), 50);
        const started = Date.now();
        await rules.runBounded(log, 'module d drain', () => new Promise(() => {}), 30);
        assert.ok(Date.now() - started < 1000);
        assert.deepStrictEqual(opts, [{ timeoutMs: 50 }]);
        assert.deepStrictEqual(log.calls, [
            ['warn', ['[Server] module b drain failed:', 'sync throw']],
            ['warn', ['[Server] module c drain failed:', 'rejected']],
            ['warn', ['[Server] module d drain did not finish within 30 ms']],
        ]);
    });
});
