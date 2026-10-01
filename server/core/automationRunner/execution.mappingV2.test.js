/**
 * One run of a definition that mixes the legacy binding kinds with the v2
 * mapping: refs and `{{ }}` templates beside picks, a compose text, a step
 * that repeats per item (step.repeat), a loop over a v2 Source, and the run
 * warnings that end up on the run row.
 *
 * What it proves end to end, through executeAutomation and runDag:
 *   - legacy bindings resolve exactly as before next to v2 ones;
 *   - REGRESSION (confirmed bug "Text mixed with a list or an object renders
 *     as raw JSON"): a compose renders a list as lines, where the template
 *     beside it still gives the JSON it always gave;
 *   - REGRESSION (confirmed bug "bind.js and the expression engine treat null
 *     rows differently under [*]"): a v2 count equals the length of the list
 *     a v2 `all` sends, null row included;
 *   - REGRESSION (M1 left open, "Missing ref/expr values and expr errors are
 *     silent"): the warnings a run collected are written to the run row, a
 *     pick's with the label the author gave it.
 *
 * Run: cd server && node --test core/automationRunner/execution.mappingV2.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installResolveStub } = require('../../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

const recorded = [];
const runUpdates = [];
const storeStub = {
    createRun: async (row) => ({ id: 'run-1', ...row }),
    updateRun: async (id, patch) => { runUpdates.push(patch); return { id, ...patch }; },
    getRun: async (id) => ({ id, status: 'running' }),
    getAutomation: async () => null,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async () => {},
    getRunTokenMap: async () => ({}),
    recordRunStep: async (row) => { recorded.push(row); return { id: `step-${recorded.length}` }; },
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    touchAutomationRunning: async () => {},
    touchRunHeartbeat: async () => {},
    updateAutomation: async () => {},
};
const restore = installResolveStub({ '../../stores/automationStore': storeStub });
test.after(() => restore());

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));

const ROWS = [
    { email: 'ada@example.org', naam: 'Ada', lines: [{ sku: 'A1' }, { sku: 'A2' }] },
    { email: 'bob@example.org', naam: 'Bob', lines: [{ sku: 'B1' }] },
    null,
];
const S = (id, ...p) => ({ root: 'steps', id, path: p });
const pick = (from, take, as, extra = {}) => ({ kind: 'pick', v: 1, from, take, as, ...extra });

function automation() {
    return {
        id: 'a1', name: 'mixed', user_id: 'u1', organization_id: null, is_active: true,
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'src', type: 'set', fields: { rows: { kind: 'literal', value: ROWS } } },
                {
                    id: 'mixed', type: 'set',
                    fields: {
                        // legacy, unchanged
                        firstRef: { kind: 'ref', path: 'steps.src.output.rows[0].email' },
                        allTemplate: { kind: 'template', value: 'Aan: {{steps.src.output.rows[*].naam}}' },
                        countExpr: { kind: 'expr', value: 'count(steps.src.output.rows[*])' },
                        // v2
                        emails: pick(S('src', 'rows', 'email'), 'all', 'list'),
                        rowCount: pick(S('src', 'rows'), 'count', 'native'),
                        rowList: pick(S('src', 'rows'), 'all', 'list'),
                        aan: { kind: 'compose', v: 1, parts: ['Aan:\n', { from: S('src', 'rows', 'naam'), take: 'all', as: 'text', join: 'bullets' }] },
                        who: { kind: 'compose', v: 1, parts: ['Klant: ', { from: { root: 'trigger', path: ['klant'] }, take: 'one', as: 'text' }] },
                        missing: pick({ root: 'trigger', path: ['telefoon'] }, 'one', 'native', { label: 'Telefoon van klant' }),
                        trigger: pick({ root: 'trigger', path: ['klant', 'naam'] }, 'one', 'native'),
                    },
                },
                {
                    id: 'each', type: 'set',
                    repeat: { over: S('src', 'rows'), max: 10 },
                    fields: { to: pick(S('src', 'rows', 'email'), 'each', 'native'), skus: pick(S('src', 'rows', 'lines', 'sku'), 'each', 'text', { join: 'comma' }) },
                },
                {
                    id: 'lp', type: 'loop', itemVar: 'line', maxIterations: 10,
                    over: S('src', 'rows', 'lines'),
                    body: [{ id: 'body', type: 'set', fields: { sku: pick({ root: 'loop', id: 'line', path: ['sku'] }, 'one', 'native') } }],
                },
            ],
            edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'mixed' }, { from: 'mixed', to: 'each' }, { from: 'each', to: 'lp' }],
        },
    };
}

let outputs;
let finalUpdate;
test.before(async () => {
    await executeAutomation(automation(), { triggerKind: 'manual', mode: 'dry_run', triggerPayload: { klant: { naam: 'Jan', plaats: 'Utrecht' } } });
    outputs = Object.fromEntries(recorded.map(r => [r.stepId, r]));
    finalUpdate = runUpdates.find(u => u.finishedAt);
});

test('every step ran', () => {
    for (const id of ['src', 'mixed', 'each', 'lp']) assert.ok(outputs[id], `no record for ${id}: ${Object.keys(outputs)}`);
    assert.equal(outputs.mixed.status, 'success');
});

test('legacy bindings resolve as they always did, beside v2 ones', () => {
    const out = outputs.mixed.output;
    assert.equal(out.firstRef, 'ada@example.org');
    assert.equal(out.allTemplate, 'Aan: ["Ada","Bob"]', 'a template keeps its JSON: frozen legacy output');
    assert.equal(out.countExpr, 2, 'the expression engine drops the null row, as it always did');
    assert.equal(out.trigger, 'Jan');
});

test('v2: count is the length of the list all sends; a compose reads as text', () => {
    const out = outputs.mixed.output;
    assert.deepStrictEqual(out.emails, ['ada@example.org', 'bob@example.org']);
    assert.equal(out.rowCount, 3);
    assert.equal(out.rowList.length, out.rowCount);
    assert.equal(out.aan, 'Aan:\n- Ada\n- Bob');
    assert.equal(out.who, 'Klant: naam: Jan\nplaats: Utrecht');
    // A pick that gives nothing gives undefined, exactly as a legacy ref does:
    // its key stays, so an upgraded binding writes what the legacy one wrote
    // (a datatable's save_row sets NULL for it; JSON leaves it out).
    assert.equal(out.missing, undefined, 'a pick that gives nothing gives no value');
    assert.equal(JSON.parse(JSON.stringify(out)).missing, undefined);
});

test('step.repeat runs once per item, each pick reading its own item', () => {
    const out = outputs.each.output;
    assert.equal(out.iterations, 3);
    assert.deepStrictEqual(out.results.map(r => r.output && r.output.to), ['ada@example.org', 'bob@example.org', undefined]);
    assert.deepStrictEqual(out.results.map(r => r.output && r.output.skus), ['A1, A2', 'B1', '']);
    // (Its per-item input snapshots are execRepeat.test.js's: a set step keeps
    // its bindings in `fields`, which run history has never recorded.)
});

test('a loop over a v2 Source goes through every item of every list', () => {
    const out = outputs.lp.output;
    assert.equal(out.iterations, 3);
    assert.deepStrictEqual(out.results.map(r => r.output.sku), ['A1', 'A2', 'B1']);
});

test('the run row carries the warnings, a pick named by its label', () => {
    assert.ok(finalUpdate, JSON.stringify(runUpdates));
    assert.ok(Array.isArray(finalUpdate.warnings), JSON.stringify(finalUpdate));
    const missing = finalUpdate.warnings.find(w => w.code === 'pick_missing' && w.params.input === 'missing');
    assert.ok(missing, JSON.stringify(finalUpdate.warnings));
    assert.equal(missing.params.label, 'Telefoon van klant');
    assert.equal(missing.text, 'input "missing": "Telefoon van klant" was empty');
    assert.ok(!JSON.stringify(finalUpdate.warnings).includes('ada@example.org'), 'a warning never holds a value');
});
