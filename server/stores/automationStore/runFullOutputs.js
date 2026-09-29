// @typecheck
/**
 * runFullOutputs.js — the full copy of a step output the run history had to
 * truncate (BFSF-435, BFSF-402).
 *
 * automation_run_steps.output_json holds at most 256 KB per payload; above
 * that, payloadTruncation swaps the whole value for a sentinel. That keeps the
 * history small and its lists fast, but a sentinel is not the output — and a
 * run that pauses on a form page or an approval rebuilds runState from these
 * rows when it resumes. Without a copy of the real value the step came back as
 * a hole: every downstream binding resolved to nothing, the run stayed green.
 *
 * So the redacted, NUL-free value is kept here, gzipped, beside the row, and
 * the sentinel carries a `fullOutputRef` naming it. Two readers:
 *   - the resume (core/automationRunner/replaySeeding.withFullOutput) swaps
 *     the sentinel back for this value before replaying it;
 *   - GET /runs/:id/steps/:stepId/full-output, so the Output panel can show
 *     and search the real thing.
 *
 * Bounded twice: only values over the row cap land here at all, and none
 * above fullOutputMaxBytes() (AUTOMATION_RUN_FULL_OUTPUT_MAX_BYTES, 0 = off).
 * Rows cascade with their run (automation-run-full-outputs-2026-09).
 */

const zlib = require('zlib');
const { promisify } = require('util');
const core = require('./core');
const { truncatePayload, fullOutputMaxBytes, FULL_OUTPUT_REF } = require('../../automation/payloadTruncation');
const log = require('../../telemetry/log');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * @typedef {{ runId: string, stepId: string, attempts: number }} FullOutputRef
 * @typedef {{ initDB: () => Promise<any>, run: (sql: string, params?: any[]) => Promise<any>, getOne: (sql: string, params?: any[]) => Promise<any> }} FullOutputDb
 */

/**
 * The two queries, over an injectable db facade (the store's own by default;
 * tests pass a fake instead of mocking the module system).
 *
 * @param {FullOutputDb} [db]
 */
function createRunFullOutputs(db = core) {
    /**
     * Keep `value` as the full output of one run-step row. Upserts, like the
     * row itself: a retried write of the same attempt replaces the copy.
     *
     * @param {FullOutputRef & { value: unknown, originalBytes: number }} args
     */
    async function saveRunFullOutput({ runId, stepId, attempts = 1, value, originalBytes }) {
        await db.initDB();
        const packed = await gzip(Buffer.from(JSON.stringify(value), 'utf8'));
        await db.run(
            `INSERT INTO automation_run_full_outputs (run_id, step_id, attempts, output_gz, original_bytes)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
                output_gz = EXCLUDED.output_gz,
                original_bytes = EXCLUDED.original_bytes,
                created_at = NOW()`,
            [runId, stepId, attempts, packed, originalBytes],
        );
    }

    /**
     * The kept full output of one run-step row, or null when there is none.
     * A truncated value is always over 256 KB, so null never means "the step
     * returned null".
     *
     * @param {string} runId
     * @param {string} stepId
     * @param {number} [attempts]
     * @returns {Promise<unknown>}
     */
    async function getRunFullOutput(runId, stepId, attempts = 1) {
        if (!runId || !stepId) return null;
        await db.initDB();
        const row = await db.getOne(
            'SELECT output_gz FROM automation_run_full_outputs WHERE run_id = $1 AND step_id = $2 AND attempts = $3',
            [runId, stepId, attempts],
        );
        if (!row?.output_gz) return null;
        const text = (await gunzip(row.output_gz)).toString('utf8');
        return JSON.parse(text);
    }

    return { saveRunFullOutput, getRunFullOutput };
}

const { saveRunFullOutput, getRunFullOutput } = createRunFullOutputs();

/**
 * What output_json should hold for one (already redacted) step output, keeping
 * the full copy first when the row is going to get the sentinel.
 *
 * The ref goes onto the sentinel only AFTER the copy is written, so a sentinel
 * never names a copy that does not exist. A failed write costs the copy, never
 * the step row: it is logged and the plain sentinel is stored, as before.
 *
 * @param {object} args
 * @param {unknown} args.value                       the redacted output
 * @param {FullOutputRef} args.ref                   the run-step row it belongs to
 * @param {(v: any) => any} [args.clean]             the row's own last pass (NUL stripping)
 * @param {(a: FullOutputRef & { value: unknown, originalBytes: number }) => Promise<void>} [args.save]
 * @param {number} [args.maxBytes]
 * @returns {Promise<unknown>}  the value for output_json
 */
async function persistableOutput({ value, ref, clean = (v) => v, save = saveRunFullOutput, maxBytes = fullOutputMaxBytes() }) {
    const t = truncatePayload(value);
    if (!t.truncated || !(maxBytes > 0) || t.originalBytes > maxBytes) return t.value;
    const attempts = Number.isInteger(ref.attempts) && ref.attempts > 0 ? ref.attempts : 1;
    try {
        await save({ runId: ref.runId, stepId: ref.stepId, attempts, value: clean(value), originalBytes: t.originalBytes });
    } catch (e) {
        log.warn(`[AutomationStore] full output of step ${ref.stepId} (run ${ref.runId}) was not kept: ${e.message}`);
        return t.value;
    }
    return { ...t.value, [FULL_OUTPUT_REF]: { runId: ref.runId, stepId: ref.stepId, attempts } };
}

module.exports = { saveRunFullOutput, getRunFullOutput, persistableOutput, createRunFullOutputs };
