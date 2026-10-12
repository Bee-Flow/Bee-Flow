/**
 * codeOutput — the code step's envelope, and the run's tolerant read of a
 * path that skipped its `.result` (bind.js walkPath).
 *
 * Run: cd server && node --test automation/codeOutput.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCodeEnvelope, missingResultTokens } = require('./codeOutput');
const { parsePath } = require('./expr');
const { resolveInputs, withBindingLog } = require('./bind');

const envelope = result => ({ result, logs: [], httpCalls: 0 });

test('isCodeEnvelope: execCode\'s output, live, rehearsed or replayed; nothing else', () => {
    assert.equal(isCodeEnvelope(envelope({ a: 1 })), true);
    assert.equal(isCodeEnvelope({ logs: ['x'], httpCalls: 0 }), true, 'a code that returned nothing has no result key');
    assert.equal(isCodeEnvelope(JSON.parse(JSON.stringify({ ...envelope(1), _dryRun: true, wouldHaveCalled: [] }))), true);
    assert.equal(isCodeEnvelope({ result: 1 }), false, 'a pinned output in another shape');
    assert.equal(isCodeEnvelope([1]), false);
    assert.equal(isCodeEnvelope(null), false);
});

test('missingResultTokens: only steps.<code>.output.<non-envelope key>', () => {
    const root = { steps: { fmt: { output: envelope({ count: 15 }) }, http: { output: { status: 200 } } } };
    const fix = p => {
        const t = missingResultTokens(parsePath(p), root);
        return t && t.map(x => x.key).join('.');
    };
    assert.equal(fix('steps.fmt.output.count'), 'steps.fmt.output.result.count');
    assert.equal(fix('steps.fmt.output.result.count'), null, 'already under result');
    assert.equal(fix('steps.fmt.output.logs'), null, 'an envelope key');
    assert.equal(fix('steps.http.output.count'), null, 'not a code step');
    assert.equal(fix('steps.gone.output.count'), null, 'a step that did not run');
    assert.equal(fix('trigger.output.count'), null);
});

test('bind: a path saved without .result reads what the code returned', () => {
    const runState = { steps: { fmt: { output: envelope({ count: 15, tickets: [{ id: 7 }] }) } }, secrets: {} };
    const entries = [];
    const r = withBindingLog(entries, () => resolveInputs({
        count: { kind: 'ref', path: 'steps.fmt.output.count' },
        first: { kind: 'template', value: 'id {{steps.fmt.output.tickets[0].id}}' },
        viaExpr: { kind: 'expr', value: 'steps.fmt.output.tickets[0].id' },
        right: { kind: 'ref', path: 'steps.fmt.output.result.count' },
    }, runState));
    assert.deepEqual(r, { count: 15, first: 'id 7', viaExpr: 7, right: 15 });
    assert.deepEqual(entries, [], 'none of them is a mapping that found nothing');
});

test('bind: a value the path finds as written wins, and a real miss is still a miss', () => {
    // A pinned output in the envelope's shape that ALSO has the key at the top.
    const runState = { steps: { fmt: { output: { ...envelope({ count: 1 }), count: 2 } } }, secrets: {} };
    assert.equal(resolveInputs({ c: { kind: 'ref', path: 'steps.fmt.output.count' } }, runState).c, 2);
    const entries = [];
    const r = withBindingLog(entries, () => resolveInputs({ n: { kind: 'ref', path: 'steps.fmt.output.nope' } }, runState));
    assert.equal(r.n, undefined);
    assert.equal(entries.length, 1);
});
