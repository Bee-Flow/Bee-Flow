/**
 * Replay seeding for resumed and partial runs (extracted verbatim from
 * automationRunner.js). Turns persisted automation_run_steps rows back into the
 * `runState.steps` a binding can resolve against, and reports which of those
 * values came from an older definition version.
 */

const automationStore = require('../../stores/automationStore');
// The 256 KB truncation sentinel is persisted under an ordinary 'success', so
// every replay-seeding path has to recognise it as "not data" (BFSF-360).
const { isTruncatedOutput, fullOutputRefOf } = require('../../automation/payloadTruncation');

// ── Replay seeding for partial runs ─────────────────────
//
// Multiple runs, not just the latest (user-reported): every "Execute step"
// click creates a run containing ONLY that step's row, so with a single-run
// window the n8n-style build-one-node-at-a-time workflow lost its working
// context on every click — executing gmail search and then executing a
// downstream Limit found no gmail output anymore, and the Limit ran against
// nothing ("arrayRef did not resolve") with the user staring at the real gmail
// output in the panel next to it.
const REPLAY_RUN_WINDOW = 10;

/**
 * One replay entry for a persisted run-step row, or null when the row holds
 * nothing a binding can resolve against.
 *
 * The ways a row can LOOK like data without being it:
 *   - the truncation SENTINEL — `{__truncated__: true, …}` sits in output_json
 *     under a perfectly ordinary 'success', and replaying it makes every
 *     downstream binding resolve against a marker (a collection node then
 *     reports "arrayRef did not resolve to an array (resolved to nothing)" —
 *     BFSF-360);
 *   - a 'pinned' or 'skipped' row in a PARTIAL run — see acceptSynthetic;
 *   - anything at all in a DRY-RUN, which is filtered a level up (at the run,
 *     in seedReplayState) because the whole run is synthetic.
 *
 * `acceptSynthetic` is for the RESUME path only. A pinned row (data pinning,
 * the documented escape hatch for a slow step) and a skipped row (a disabled
 * step, or one whose arrayRef did not resolve) both carry a real recorded
 * output, and a resume never dispatches those steps again — dropping them left
 * a HOLE in runState, which for a pinned brancher aborted the resume with
 * "Replay missing branch label" and made the approval impossible to complete
 * (W5-14). A partial run must NOT accept them: it re-executes whatever it
 * cannot replay, and the definition's CURRENT pins are overlaid separately, so
 * an unpinned-since step would otherwise keep serving a stale synthetic value.
 */
function replayEntryFromRow(row, stepId, { acceptSynthetic = false } = {}) {
    const usableStatus = row.status === 'success'
        || (acceptSynthetic && (row.status === 'pinned' || row.status === 'skipped'));
    if (usableStatus && row.output != null && !isTruncatedOutput(row.output)) {
        return { output: row.output, status: 'success' };
    }
    if (row.status === 'handled_error') {
        // §WS4: a step whose failure was absorbed by an on_error branch.
        // Rebuild the handled-error payload so error-branch bindings
        // (steps.<id>.error.message etc.) resolve, and so runDag's replay path
        // routes this step along 'on_error' again.
        return {
            status: 'handled_error',
            output: null,
            error: { message: row.error, errorClass: row.errorClass, stepId },
        };
    }
    return null;
}

/**
 * The row with its truncation sentinel swapped back for the full output the
 * store kept beside it, or the row unchanged (BFSF-435).
 *
 * For the RESUME path. A resume never dispatches a step before its pause
 * again, so a sentinel it cannot swap back is a hole in runState, not a cue to
 * re-execute (replayGaps.js decides what that hole costs). A partial run keeps
 * reading the sentinel as absent and re-executes the step, as it always has.
 *
 * Only a sentinel that names its copy is looked up: one written before copies
 * were kept, or one too large to keep, has none. A copy that cannot be read
 * leaves the sentinel in place — the same outcome as having none.
 *
 * The copy is read at the ROW's own coordinates, and only when the ref names
 * exactly those. The ref is JSON inside output_json, and an output under the
 * cap is stored as whatever the step returned — so a web response shaped like
 * a sentinel could otherwise point this resume at another run's copy.
 */
async function withFullOutput(row) {
    const ref = row ? fullOutputRefOf(row.output) : null;
    if (!ref || typeof automationStore.getRunFullOutput !== 'function') return row;
    const attempts = row.attempts ?? 1;
    if (ref.runId !== row.runId || ref.stepId !== row.stepId || ref.attempts !== attempts) return row;
    const full = await Promise.resolve(automationStore.getRunFullOutput(row.runId, row.stepId, attempts)).catch(() => null);
    return full != null ? { ...row, output: full } : row;
}

/** Step rows for several runs, in ONE query when the store offers it. */
async function loadRunStepsForRuns(runIds, store = automationStore) {
    const byRun = new Map(runIds.map(id => [id, []]));
    if (!runIds.length) return byRun;
    // BFSF-359: the per-run loop below is N+1, and getRunSteps is `SELECT *` —
    // it drags ten runs' worth of input_json across the wire so the seeding can
    // read six columns. The batched store call is preferred when present; the
    // loop stays as the fallback so this works on a store that predates it.
    if (typeof store.getRunStepsForRuns === 'function') {
        const rows = await Promise.resolve(store.getRunStepsForRuns(runIds)).catch(() => null);
        if (Array.isArray(rows)) {
            for (const r of rows) byRun.get(r.runId)?.push(r);
            return byRun;
        }
    }
    for (const id of runIds) {
        byRun.set(id, await Promise.resolve(store.getRunSteps(id)).catch(() => []));
    }
    return byRun;
}

/**
 * Build the replay state for a partial run out of the last REPLAY_RUN_WINDOW
 * LIVE runs of this automation.
 *
 * `stepIdFor(row)` maps a persisted row onto the id it replays under, and
 * returns null for rows that are not nodes of the graph being run.
 *
 * Two rules make this AUTHORITATIVE per step, which is what it was missing:
 *
 *   1. DRY-RUN runs are excluded, unconditionally. A dry-run's recorded output
 *      is model-synthesized (runDag stamps _dryRunSynthesised / _dryRunFallback
 *      on it), and the seeding filtered on nothing but automation_id — so a
 *      LIVE partial run happily resolved a send step's recipient to a
 *      fabricated "fake-sample@example.com" (W3-1).
 *   2. The NEWEST run that has any row for a step decides that step, including
 *      when its answer is "no data". The old loop only ever WROTE, on
 *      success/handled_error, and never deleted — so a newer run in which the
 *      step errored, was cancelled or was skipped left the older run's success
 *      in place, and that stale output kept winning for the whole ten-run
 *      window. That is the mechanism behind BFSF-360's "Limit node returns 10
 *      stale records, green" (W3-2). Deleting instead lets fillMissingUpstream
 *      re-execute the step and produce real data.
 *
 * Runs from an OLDER definition version are kept, deliberately: every canvas
 * edit bumps `version`, so scoping to the current one would throw away the
 * previous ▶ Execute's output on every keystroke — exactly the
 * build-one-node-at-a-time workflow the window exists to support. They are
 * reported instead, per step, as `staleFrom` so the inspector can say "this
 * came from version 4".
 *
 * `opts.store` reads the runs from another store than automationStore (the
 * mapping upgrade's tests hand in their own; automation/mappingUpgrade.js
 * reads its evidence through this same window).
 */
async function seedReplayState(automationId, currentVersion, stepIdFor, opts = {}) {
    const { store = automationStore, ...entryOpts } = opts;
    const all = await Promise.resolve(store.getRunsForAutomation(automationId, { limit: REPLAY_RUN_WINDOW })).catch(() => []);
    const runsWindow = (all || []).filter(r => r?.id && r.mode !== 'dry_run');
    const stepsByRun = await loadRunStepsForRuns(runsWindow.map(r => r.id), store);
    const replayState = {};
    const staleFrom = {}; // stepId → the definition version its data came from
    // Walk OLDEST → NEWEST so the newest row for a step simply overwrites (or
    // removes) whatever an older run said — most-recent-per-step wins with no
    // bookkeeping. Rows inside a run are ordered by attempts ASC, so a final
    // success/handled_error also wins over the earlier failed attempts.
    for (const priorRun of [...runsWindow].reverse()) {
        for (const row of (stepsByRun.get(priorRun.id) || [])) {
            const stepId = stepIdFor(row);
            if (!stepId) continue;
            const entry = replayEntryFromRow(row, stepId, entryOpts);
            if (!entry) {
                delete replayState[stepId];
                delete staleFrom[stepId];
                continue;
            }
            replayState[stepId] = entry;
            if (currentVersion != null && priorRun.version != null && priorRun.version !== currentVersion) {
                staleFrom[stepId] = priorRun.version;
            } else {
                delete staleFrom[stepId];
            }
        }
    }
    return { replayState, staleFrom, runsWindow, stepsByRun, parentRunId: runsWindow[0]?.id || null };
}

/**
 * Tag a partial run's returned row with the steps whose replayed upstream data
 * came from an OLDER definition version.
 *
 * The alternative was to scope the replay window to the current version and
 * drop those rows — but every canvas edit bumps the version, so that would
 * silently delete the working context between two ▶ Execute clicks. Keeping the
 * data and SAYING it is from another version leaves the workflow intact and
 * still lets the inspector mark the value as stale rather than presenting it as
 * this definition's output. Not persisted: it describes this response, not the
 * run.
 */
function withReplayStale(runRow, staleFrom) {
    const entries = staleFrom ? Object.entries(staleFrom) : [];
    if (!runRow || entries.length === 0) return runRow;
    return { ...runRow, replayStale: entries.map(([stepId, version]) => ({ stepId, version })) };
}

module.exports = { replayEntryFromRow, seedReplayState, withReplayStale, withFullOutput };
