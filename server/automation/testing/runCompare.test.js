// @typecheck
'use strict';
/**
 * The run compare, against a fake store (no database).
 * Run: cd server && node --test automation/testing/runCompare.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { compareRuns } = require('./runCompare');

const T = '2026-10-01T10:00:00.000Z';
/**
 * @param {string} id
 * @param {Record<string, unknown>} [over]
 */
const run = (id, over = {}) => ({
    id, automationId: 'a1', version: 3, mode: 'dry_run', triggerKind: 'dry_run', status: 'success',
    startedAt: T, userId: 'u1', startedByUserId: 'u1', rootRunId: id, ...over,
});
/**
 * @param {string} runId
 * @param {string} stepId
 * @param {unknown} output
 * @param {Record<string, unknown>} [over]
 */
const row = (runId, stepId, output, over = {}) => ({
    runId, stepId, stepType: 'set_variable', parentStepId: /** @type {string | null} */ (null), branchIndex: /** @type {number | null} */ (null), attempts: 1,
    status: 'success', output, error: /** @type {string | null} */ (null), ...over,
});

/**
 * @param {{ steps?: Record<string, any[]>, files?: any[], fullOutputs?: Record<string, unknown>, definitions?: Record<string, unknown> }} [data]
 */
function fakeStore({ steps = {}, files = [], fullOutputs = {}, definitions = {} } = {}) {
    return {
        getRunStepsForChain: async (/** @type {string} */ id) => steps[id] || [],
        listGeneratedFilesForRuns: async (/** @type {string[]} */ ids) => files.filter((f) => ids.includes(f.runId)),
        getGeneratedFileForRuns: async (/** @type {string} */ id, /** @type {string[]} */ ids) => files.find((f) => f.id === id && ids.includes(f.runId)) || null,
        getRunFullOutput: async (/** @type {string} */ runId, /** @type {string} */ stepId, /** @type {number} */ attempts) => fullOutputs[`${runId}/${stepId}/${attempts}`] ?? null,
        getVersionDefinition: async (/** @type {string} */ aid, /** @type {number} */ v) => definitions[`${aid}@${v}`] || null,
    };
}
const noStorage = { streamFile: async () => { throw new Error('no bytes'); } };

/**
 * @param {ReturnType<typeof fakeStore>} store
 * @param {Record<string, unknown>} [over]
 * @param {Record<string, unknown>} [deps]
 */
const compare = (store, over = {}, deps = {}) => compareRuns({
    runA: run('A'), runB: run('B'), legsA: [run('A')], legsB: [run('B')], viewerId: 'u1', ...over,
}, { store, storage: noStorage, ...deps });

/**
 * @param {Awaited<ReturnType<typeof compare>>} res
 * @param {string} id
 */
const stepOf = (res, id) => res.steps.find((s) => s.stepId === id);

test('identical runs are the same; the header carries both runs', async () => {
    const out = [row('A', 's1', { v: 1 }), row('A', 's2', { w: [1, 2] })];
    const res = await compare(fakeStore({ steps: { A: out, B: out.map(r => ({ ...r, runId: 'B' })) } }));
    assert.strictEqual(res.verdict, 'same');
    assert.deepStrictEqual(res.summary, { same: 2, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 });
    assert.deepStrictEqual(res.a, { runId: 'A', status: 'success', mode: 'dry_run', version: 3, triggerKind: 'dry_run', startedAt: T });
    assert.strictEqual(res.truncated, false);
    assert.deepStrictEqual(res.steps.map(s => s.key), ['/s1#', '/s2#']);
});

test('a changed output is changed, with the path and cut values', async () => {
    const res = await compare(fakeStore({ steps: {
        A: [row('A', 's1', { v: 1, list: [1, 2] })],
        B: [row('B', 's1', { v: 2, list: [1, 2, 3] })],
    } }));
    const s = stepOf(res, 's1');
    assert.strictEqual(s.verdict, 'changed');
    assert.strictEqual(s.kind, 'json');
    assert.deepStrictEqual(s.changes.map(c => c.path), ['v', 'list.length']);
    assert.strictEqual(res.verdict, 'changed');
});

test('an AI step\'s differences are soft; so is a step the definition says calls a model', async () => {
    const definitions = { 'a1@3': { steps: [{ id: 'x1', type: 'parse_json', mode: 'ai' }] } };
    const res = await compare(fakeStore({
        definitions,
        steps: {
            A: [row('A', 'ai1', { text: 'one' }, { stepType: 'ai_step' }), row('A', 'x1', { v: 1 }, { stepType: 'parse_json' }), row('A', 'plain', { v: 1 })],
            B: [row('B', 'ai1', { text: 'two' }, { stepType: 'ai_step' }), row('B', 'x1', { v: 2 }, { stepType: 'parse_json' }), row('B', 'plain', { v: 1 })],
        },
    }));
    assert.deepStrictEqual([stepOf(res, 'ai1').verdict, stepOf(res, 'ai1').softReason], ['soft', 'ai']);
    assert.deepStrictEqual([stepOf(res, 'x1').verdict, stepOf(res, 'x1').softReason], ['soft', 'ai']);
    assert.strictEqual(stepOf(res, 'plain').verdict, 'same');
    assert.strictEqual(res.verdict, 'soft');
    assert.strictEqual(res.summary.soft, 2);
});

test('exactly one simulated side makes the difference soft (simulated)', async () => {
    const res = await compare(fakeStore({ steps: {
        A: [row('A', 'mail', { id: 'm-1', sent: true }, { stepType: 'integration_action' })],
        B: [row('B', 'mail', { id: 'sample', sent: true, _dryRun: true }, { stepType: 'integration_action' })],
    } }));
    const s = stepOf(res, 'mail');
    assert.deepStrictEqual([s.verdict, s.softReason], ['soft', 'simulated']);
    assert.ok(!s.changes.some(c => c.path === '_dryRun'));
    // both simulated: an ordinary change
    const both = await compare(fakeStore({ steps: {
        A: [row('A', 'mail', { id: 'm-1', _dryRun: true })],
        B: [row('B', 'mail', { id: 'm-2', _dryRunSynthesised: true })],
    } }));
    assert.strictEqual(stepOf(both, 'mail').verdict, 'changed');
});

test('only_a, only_b and status_changed', async () => {
    const res = await compare(fakeStore({ steps: {
        A: [row('A', 'gone', 1), row('A', 'flip', 1), row('A', 'keep', 1)],
        B: [row('B', 'fresh', 1), row('B', 'flip', 1, { status: 'error', error: 'it failed' }), row('B', 'keep', 1)],
    } }));
    assert.strictEqual(stepOf(res, 'gone').verdict, 'only_a');
    assert.strictEqual(stepOf(res, 'fresh').verdict, 'only_b');
    assert.strictEqual(stepOf(res, 'flip').verdict, 'status_changed');
    assert.deepStrictEqual(res.summary, { same: 1, changed: 1, soft: 0, onlyA: 1, onlyB: 1, notComparable: 0 });
    assert.strictEqual(res.verdict, 'changed');
});

test('the last attempt of a step is the one compared; branch and parent keep keys apart', async () => {
    const res = await compare(fakeStore({ steps: {
        A: [row('A', 's', 'old', { attempts: 1, status: 'error' }), row('A', 's', 'ok', { attempts: 2 }), row('A', 'c', 1, { parentStepId: 'p', branchIndex: 0 }), row('A', 'c', 2, { parentStepId: 'p', branchIndex: 1 })],
        B: [row('B', 's', 'ok', { attempts: 1 }), row('B', 'c', 1, { parentStepId: 'p', branchIndex: 0 }), row('B', 'c', 2, { parentStepId: 'p', branchIndex: 1 })],
    } }));
    assert.strictEqual(stepOf(res, 's').verdict, 'same');
    assert.deepStrictEqual(res.steps.filter(s => s.stepId === 'c').map(s => s.key), ['p/c#0', 'p/c#1']);
    assert.strictEqual(res.verdict, 'same');
});

test('an error text that differs is a change on $error', async () => {
    const res = await compare(fakeStore({ steps: {
        A: [row('A', 's', null, { status: 'error', error: 'bad input' })],
        B: [row('B', 's', null, { status: 'error', error: 'timeout' })],
    } }));
    assert.deepStrictEqual(stepOf(res, 's').changes, [{ path: '$error', change: 'changed', before: '"bad input"', after: '"timeout"' }]);
});

/**
 * @param {string} runId
 * @param {string} stepId
 * @param {boolean} [withRef]
 */
const sentinel = (runId, stepId, withRef = true) => ({
    __truncated__: true, originalBytes: 999999, headSample: '{',
    ...(withRef ? { fullOutputRef: { runId, stepId, attempts: 1 } } : {}),
});

test('a cut output is swapped for its full copy; without a copy the step is not_comparable', async () => {
    const store = fakeStore({
        steps: {
            A: [row('A', 'big', sentinel('A', 'big')), row('A', 'lost', sentinel('A', 'lost', false))],
            B: [row('B', 'big', sentinel('B', 'big')), row('B', 'lost', sentinel('B', 'lost', false))],
        },
        fullOutputs: { 'A/big/1': { rows: [1, 2] }, 'B/big/1': { rows: [1, 3] } },
    });
    const res = await compare(store);
    assert.deepStrictEqual(stepOf(res, 'big').changes.map(c => c.path), ['rows[1]']);
    assert.strictEqual(stepOf(res, 'lost').verdict, 'not_comparable');
    assert.strictEqual(res.summary.notComparable, 1);
    assert.strictEqual(res.verdict, 'changed');
});

test('a full-output reference to a run outside the readable legs is not followed', async () => {
    const store = fakeStore({
        steps: { A: [row('A', 'big', sentinel('OTHER', 'big'))], B: [row('B', 'big', { rows: 1 })] },
        fullOutputs: { 'OTHER/big/1': { secret: true } },
    });
    const res = await compare(store);
    assert.strictEqual(stepOf(res, 'big').verdict, 'not_comparable');
    assert.deepStrictEqual(stepOf(res, 'big').changes, []);
});

test('a leg on the starter\'s own connections is never opened for another viewer', async () => {
    const callerLeg = run('A2', { rootRunId: 'A', connectionsMode: 'caller', startedByUserId: 'someone' });
    const store = fakeStore({ steps: {
        A: [row('A', 's1', { v: 1 }), row('A2', 's2', { secret: 'x' })],
        B: [row('B', 's1', { v: 1 }), row('B', 's2', { secret: 'y' })],
    } });
    const res = await compare(store, { legsA: [run('A'), callerLeg] });
    assert.strictEqual(stepOf(res, 's1').verdict, 'same');
    const hidden = stepOf(res, 's2');
    assert.strictEqual(hidden.verdict, 'not_comparable');
    assert.deepStrictEqual(hidden.changes, []);
    // The same leg is readable for the person who started it.
    const own = await compare(store, { legsA: [run('A'), callerLeg], viewerId: 'someone' });
    assert.strictEqual(stepOf(own, 's2').verdict, 'changed');
});

test('the step cap truncates the result', async () => {
    /** @param {string} id */
    const many = (id) => Array.from({ length: 10 }, (_, i) => row(id, `s${i}`, i));
    const res = await compare(fakeStore({ steps: { A: many('A'), B: many('B') } }), {}, { caps: { maxSteps: 4 } });
    assert.strictEqual(res.steps.length, 4);
    assert.strictEqual(res.truncated, true);
    const all = await compare(fakeStore({ steps: { A: many('A'), B: many('B') } }), {}, { caps: { maxSteps: 0 } });
    assert.strictEqual(all.steps.length, 10);
    assert.strictEqual(all.truncated, false);
});

test('stepId narrows the comparison to that step', async () => {
    const res = await compare(fakeStore({ steps: { A: [row('A', 's1', 1), row('A', 's2', 1)], B: [row('B', 's1', 2), row('B', 's2', 2)] } }), { stepId: 's2' });
    assert.deepStrictEqual(res.steps.map(s => s.stepId), ['s2']);
});

test('ignorePaths are honoured and a change cap marks the step', async () => {
    const store = fakeStore({ steps: { A: [row('A', 's', { id: 1, v: 1, w: 1, x: 1 })], B: [row('B', 's', { id: 2, v: 2, w: 2, x: 2 })] } });
    const ignored = await compare(store, { ignorePaths: ['id', 'v', 'w', 'x'] });
    assert.strictEqual(ignored.verdict, 'same');
    const capped = await compare(store, {}, { caps: { maxChanges: 2 } });
    assert.strictEqual(stepOf(capped, 's').changes.length, 2);
    assert.strictEqual(stepOf(capped, 's').changesTruncated, true);
});

// ── generated files ──────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {string} runId
 * @param {Record<string, unknown>} [over]
 */
const file = (id, runId, over = {}) => ({
    id, runId, automationId: 'a1', stepId: 'doc', storageKey: `k/${id}`, filename: 'report.pdf',
    mimeType: 'application/pdf', size: 4, createdAt: T, ...over,
});
/** @param {Record<string, Buffer>} blobs */
const storageOf = (blobs) => ({
    streamFile: async (/** @type {string} */ key) => {
        if (!(key in blobs)) throw new Error('missing');
        return { stream: Readable.from([blobs[key]]), contentLength: blobs[key].length };
    },
});
/** @param {string} fileId */
const handle = (fileId) => ({ kind: 'generated_file', fileId });

test('generated files are paired by step and compared; a handle in an output is compared by content', async () => {
    const store = fakeStore({
        steps: { A: [row('A', 'doc', { file: handle('fa') })], B: [row('B', 'doc', { file: handle('fb') })] },
        files: [file('fa', 'A'), file('fb', 'B'), file('fx', 'B', { createdAt: '2026-10-01T11:00:00.000Z', filename: 'extra.txt', mimeType: 'text/plain' })],
    });
    const storage = storageOf({ 'k/fa': Buffer.from('aaaa'), 'k/fb': Buffer.from('bbbb'), 'k/fx': Buffer.from('xx') });
    const res = await compare(store, {}, { storage });
    const s = stepOf(res, 'doc');
    assert.strictEqual(s.verdict, 'changed');
    assert.ok(s.changes.some(c => c.path === 'file.sha256'));
    assert.ok(!s.changes.some(c => c.path === 'file.fileId'));
    assert.deepStrictEqual(s.files.map(f => f.change), ['changed', 'added']);
    assert.strictEqual(s.files[0].a.name, 'report.pdf');
    assert.strictEqual(s.files[1].a, null);
});

test('identical file bytes in two runs are the same and make the step the same', async () => {
    const store = fakeStore({
        steps: { A: [row('A', 'doc', { file: handle('fa') })], B: [row('B', 'doc', { file: handle('fb') })] },
        files: [file('fa', 'A'), file('fb', 'B')],
    });
    const storage = storageOf({ 'k/fa': Buffer.from('same'), 'k/fb': Buffer.from('same') });
    const res = await compare(store, {}, { storage });
    assert.strictEqual(stepOf(res, 'doc').verdict, 'same');
    assert.strictEqual(stepOf(res, 'doc').files[0].change, 'same');
});

test('a handle naming a file of the OTHER side\'s journey does not resolve', async () => {
    const store = fakeStore({
        steps: { A: [row('A', 'doc', { file: handle('fb') })], B: [row('B', 'doc', { file: handle('fb') })] },
        files: [file('fb', 'B')],
    });
    const storage = storageOf({ 'k/fb': Buffer.from('bbbb') });
    const res = await compare(store, {}, { storage });
    // Side a cannot see fb, side b can: reported as added, never as a match.
    assert.deepStrictEqual(stepOf(res, 'doc').changes.map(c => c.change), ['added']);
});

test('files of another automation in the same runs are not summarised', async () => {
    const store = fakeStore({
        steps: { A: [row('A', 'doc', 1)], B: [row('B', 'doc', 1)] },
        files: [file('fa', 'A', { automationId: 'other' })],
    });
    const res = await compare(store, {}, { storage: storageOf({ 'k/fa': Buffer.from('x') }) });
    assert.strictEqual(stepOf(res, 'doc').files, undefined);
});

test('a version definition that cannot be read is logged and the step type alone decides', async () => {
    const log = require('../../telemetry/log');
    const original = log.debug;
    /** @type {string[]} */
    const lines = [];
    log.debug = (line) => { lines.push(String(line)); };
    try {
        const store = {
            ...fakeStore({ steps: {
                A: [row('A', 'ai1', { text: 'one' }, { stepType: 'ai_step' })],
                B: [row('B', 'ai1', { text: 'two' }, { stepType: 'ai_step' })],
            } }),
            getVersionDefinition: async () => { throw new Error('definition store down'); },
        };
        const res = await compare(store);
        assert.strictEqual(stepOf(res, 'ai1').verdict, 'soft');
        assert.ok(lines.some(l => l.includes('[automation/runCompare]') && l.includes('definition store down')), lines.join('\n'));
    } finally {
        log.debug = original;
    }
});
