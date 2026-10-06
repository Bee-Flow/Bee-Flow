/**
 * The 256 KB truncation cap and its sentinel.
 *
 * `isTruncatedOutput` exists because the sentinel is persisted in `output_json`
 * under a perfectly ordinary status='success' row, so every "is there cached
 * output for this step" test accepted it and replayed a marker as if it were
 * the step's data — a collection node then reported "arrayRef did not resolve
 * to an array (resolved to nothing)" while the real rows sat in the panel next
 * to it (BFSF-360).
 *
 * Run: node --test automation/payloadTruncation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    truncatePayload, isTruncatedOutput, fullOutputRefOf, fullOutputMaxBytes,
    TRUNCATED_MARKER, DEFAULT_MAX_BYTES, FULL_OUTPUT_REF, DEFAULT_FULL_OUTPUT_MAX_BYTES,
} = require('./payloadTruncation');

test('a payload under the cap passes through untouched', () => {
    const value = { rows: [1, 2, 3] };
    const r = truncatePayload(value);
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.value, value);
    assert.strictEqual(isTruncatedOutput(r.value), false);
});

test('a payload over the cap becomes the sentinel, and the sentinel is recognised', () => {
    const big = { blob: 'x'.repeat(DEFAULT_MAX_BYTES + 10) };
    const r = truncatePayload(big);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.value[TRUNCATED_MARKER], true);
    assert.ok(r.value.originalBytes > DEFAULT_MAX_BYTES);
    assert.ok(isTruncatedOutput(r.value), 'the replay-seeding paths must be able to spot this');
});

test('isTruncatedOutput says no to everything that is real data', () => {
    for (const v of [null, undefined, 0, '', 'x', [], [1], { a: 1 }, { __truncated__: false }, { __truncated__: 'yes' }]) {
        assert.strictEqual(isTruncatedOutput(v), false, `unexpected true for ${JSON.stringify(v)}`);
    }
});

test('a hand-written sentinel-shaped output is recognised (that is what comes back from the DB)', () => {
    assert.strictEqual(
        isTruncatedOutput({ __truncated__: true, originalBytes: 1_500_000, headSample: '{"results":[' }),
        true,
    );
});

// ── The kept full copy (BFSF-435) ──────────────────────────────────────────

test('a sentinel naming its full copy is still a sentinel — never data', () => {
    const sentinel = {
        __truncated__: true, originalBytes: 400_000, headSample: '{"items":[',
        [FULL_OUTPUT_REF]: { runId: 'run-a', stepId: 'http1', attempts: 2 },
    };
    assert.strictEqual(isTruncatedOutput(sentinel), true, 'replay, pin and mapping guards must keep refusing it');
    assert.deepStrictEqual(fullOutputRefOf(sentinel), { runId: 'run-a', stepId: 'http1', attempts: 2 });
});

test('fullOutputRefOf finds nothing where no copy was kept', () => {
    // Old rows (written before copies existed), a copy too large to keep, and
    // real data that merely has a key of the same name.
    assert.strictEqual(fullOutputRefOf({ __truncated__: true, originalBytes: 9e6, headSample: '' }), null);
    assert.strictEqual(fullOutputRefOf({ [FULL_OUTPUT_REF]: { runId: 'r', stepId: 's', attempts: 1 } }), null);
    assert.strictEqual(fullOutputRefOf({ __truncated__: true, [FULL_OUTPUT_REF]: { runId: '', stepId: 's' } }), null);
    assert.strictEqual(fullOutputRefOf({ __truncated__: true, [FULL_OUTPUT_REF]: 'r/s' }), null);
    assert.strictEqual(fullOutputRefOf(null), null);
});

test('a ref without a usable attempt number reads as the first attempt', () => {
    assert.strictEqual(fullOutputRefOf({ __truncated__: true, [FULL_OUTPUT_REF]: { runId: 'r', stepId: 's' } }).attempts, 1);
    assert.strictEqual(fullOutputRefOf({ __truncated__: true, [FULL_OUTPUT_REF]: { runId: 'r', stepId: 's', attempts: 0 } }).attempts, 1);
});

test('fullOutputMaxBytes: a default, an override, 0 to switch off, and junk falls back', () => {
    assert.strictEqual(fullOutputMaxBytes({}), DEFAULT_FULL_OUTPUT_MAX_BYTES);
    assert.ok(DEFAULT_FULL_OUTPUT_MAX_BYTES > DEFAULT_MAX_BYTES, 'the copy exists for values over the row cap');
    assert.strictEqual(fullOutputMaxBytes({ AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES: '1048576' }), 1_048_576);
    assert.strictEqual(fullOutputMaxBytes({ AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES: '0' }), 0);
    assert.strictEqual(fullOutputMaxBytes({ AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES: 'lots' }), DEFAULT_FULL_OUTPUT_MAX_BYTES);
    assert.strictEqual(fullOutputMaxBytes({ AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES: '-5' }), DEFAULT_FULL_OUTPUT_MAX_BYTES);
    assert.strictEqual(fullOutputMaxBytes({ AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES: ' ' }), DEFAULT_FULL_OUTPUT_MAX_BYTES);
});

test('truncatePayload itself is unchanged: the sentinel carries no ref of its own', () => {
    const r = truncatePayload({ blob: 'x'.repeat(DEFAULT_MAX_BYTES + 10) });
    // `preview`/`previewCut` are the value's shape (payloadTruncation.preview.test.js).
    assert.deepStrictEqual(Object.keys(r.value).sort(), ['__truncated__', 'headSample', 'originalBytes', 'preview', 'previewCut']);
    assert.strictEqual(r.value[FULL_OUTPUT_REF], undefined);
});
