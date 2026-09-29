/**
 * Step input/output truncation for the run history (§13).
 *
 * The run-step rows hold the full step input + output as JSONB. Some
 * integrations (search, large attachments, sheet exports) emit
 * megabyte-scale payloads that explode database size and slow run
 * detail rendering. We cap the persisted JSON at `DEFAULT_MAX_BYTES` and
 * replace anything past the limit with a marker.
 *
 * An OUTPUT past the limit is not simply dropped any more (BFSF-435): its
 * full copy is kept beside the row, gzipped, in automation_run_full_outputs
 * (stores/automationStore/runFullOutputs.js), up to `fullOutputMaxBytes()`,
 * and the sentinel then carries a `fullOutputRef` naming it. A run that
 * resumes after a form page or an approval rebuilds runState from these rows,
 * and without that copy the step came back as a silent hole.
 *
 * Public:
 *   truncatePayload(value, opts?) → { value, truncated, originalBytes }
 *   isTruncatedOutput(value)      → true for the persisted sentinel
 *   fullOutputRefOf(value)        → the sentinel's { runId, stepId, attempts }, or null
 *   fullOutputMaxBytes(env?)      → the largest output whose full copy is kept
 *
 * Non-mutating; returns a new value tree when truncation kicks in.
 */

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB per payload
const TRUNCATED_MARKER = '__truncated__';
// Key on the sentinel naming the kept full copy. A sibling of the marker, never
// merged into user data: the sentinel is its own object.
const FULL_OUTPUT_REF = 'fullOutputRef';
// 8 MiB of serialized JSON. Stored gzipped, so the row is typically a fraction
// of that; above it the sentinel is all there is, as before.
const DEFAULT_FULL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

function truncatePayload(value, opts = {}) {
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    let originalBytes = 0;
    let serialized;
    try {
        serialized = JSON.stringify(value);
        originalBytes = serialized ? Buffer.byteLength(serialized, 'utf8') : 0;
    } catch {
        return { value, truncated: false, originalBytes: 0 };
    }
    if (originalBytes <= maxBytes) {
        return { value, truncated: false, originalBytes };
    }
    // Replace with a marker. Keep a short head sample so the user can
    // still see the shape. This function drops the rest; for a step OUTPUT
    // the store keeps a full copy beside the row and adds `fullOutputRef`
    // (stores/automationStore/runFullOutputs.persistableOutput, BFSF-435).
    const headSample = serialized.slice(0, Math.min(serialized.length, 1024));
    return {
        value: {
            [TRUNCATED_MARKER]: true,
            originalBytes,
            headSample,
        },
        truncated: true,
        originalBytes,
    };
}

/**
 * Is this value the truncation SENTINEL rather than a step's real output?
 *
 * It matters because the sentinel is persisted in `output_json` on a row whose
 * status is a perfectly ordinary 'success' — so every "is there cached output
 * for this step" test (`status === 'success' && output != null`) accepts it and
 * replays `{__truncated__: true, …}` as if it were the step's data. Downstream
 * bindings then resolve against the sentinel: a collection node's resolveArrayRef
 * returns null and the run reports "arrayRef did not resolve to an array
 * (resolved to nothing)" while the user is looking at the real 8k-row output in
 * the panel next to it (BFSF-360, fourth symptom).
 *
 * A sentinel is not data. Seeding paths must treat such a row as ABSENT so the
 * step is re-executed and produces the real thing — or, on a resume, which
 * must not re-execute anything, swap it for the kept full copy (see
 * fullOutputRefOf and core/automationRunner/replaySeeding.withFullOutput).
 *
 * The builder has carried the same guard for a while
 * (agent-hub/src/components/automation/Builder/mapping/realOutputs.js);
 * this is the server-side half.
 */
function isTruncatedOutput(value) {
    return !!value && typeof value === 'object' && value[TRUNCATED_MARKER] === true;
}

/**
 * Where the full copy of a truncated output lives, when one was kept: the
 * sentinel's `{ runId, stepId, attempts }`, or null for real data, for a
 * sentinel written before copies were kept, and for one too large to keep.
 */
function fullOutputRefOf(value) {
    if (!isTruncatedOutput(value)) return null;
    const ref = value[FULL_OUTPUT_REF];
    if (!ref || typeof ref !== 'object') return null;
    const { runId, stepId, attempts } = ref;
    if (typeof runId !== 'string' || !runId || typeof stepId !== 'string' || !stepId) return null;
    return { runId, stepId, attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : 1 };
}

/**
 * The largest output (serialized bytes, after redaction) whose full copy is
 * kept beside its truncated row. `AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES`
 * overrides the default; 0 turns the copies off, which brings back the old
 * behaviour — including the resume failure for a later step that reads such
 * an output (core/automationRunner/replayGaps.js). Anything unparseable falls
 * back to the default rather than silently switching the copies off.
 */
function fullOutputMaxBytes(env = process.env) {
    const raw = env?.AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES;
    if (raw == null || String(raw).trim() === '') return DEFAULT_FULL_OUTPUT_MAX_BYTES;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FULL_OUTPUT_MAX_BYTES;
}

module.exports = {
    truncatePayload, isTruncatedOutput, fullOutputRefOf, fullOutputMaxBytes,
    DEFAULT_MAX_BYTES, TRUNCATED_MARKER, FULL_OUTPUT_REF, DEFAULT_FULL_OUTPUT_MAX_BYTES,
};
