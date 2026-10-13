import type { DryRun } from '../builderStream';
import { deepEqual } from '../../utils/deepEqual';
import { API_BASE, authFetch } from '../../utils/helpers';

/** Run-row helpers of the automation builder: the poll's row compare, the
 *  recovery of an "Execute step" whose request was cut off, and the error
 *  bookkeeping of a failed execute. */

/**
 * True when two run-step rows are the same as far as anything on screen is
 * concerned — status, output, duration and retry count are the only fields
 * StatusStrip / the output panel render (see RunTabContainer). Deliberately
 * ignores everything else (startedAt/finishedAt, piiSummary, ...) so a poll
 * that re-fetches an already-'running' row with nothing new to say doesn't
 * read as a change (BFSF-396). `output` needs a real value compare, not
 * `===` — it's freshly parsed JSON on every poll, so two structurally
 * identical outputs never share a reference.
 */
export function stepRowUnchanged(a: Record<string, unknown> | null, b: Record<string, unknown> | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.status === b.status
        && a.durationMs === b.durationMs
        && a.attempts === b.attempts
        && deepEqual(a.output, b.output)
        // A re-run that fixed a mapping changes only its warnings; keeping the
        // old row would go on showing "found nothing" for a fixed input.
        && deepEqual(a.bindingWarnings, b.bindingWarnings);
}

/**
 * Settle a 'running' progress stub (set by watchActiveRun) so
 * `liveRunInFlight` clears when a run ends without us receiving a final run
 * record — e.g. an errored execute. A genuine completed run (status
 * 'success'/'error' from the server) is left untouched.
 */
/** A proxy between the browser and the server gave up, not the step. */
export const GATEWAY_DROP = new Set([408, 502, 503, 504]);
/** How long a dropped "Execute step" keeps waiting for its run to finish. */
const DROP_WAIT_MS = 15 * 60 * 1000;
const DROP_POLL_MS = 1500;
const RUN_DONE = (status?: string) => !!status && status !== 'running' && status !== 'queued';

/**
 * The run behind an "Execute step" whose request was cut off (a proxy timeout
 * or a dropped connection): find it, wait until it settles, and return its run
 * and step rows — or null when there is no such run to wait for, so the caller
 * reports the failure as before.
 *
 * The run id normally comes from watchActiveRun; when the drop came before it
 * was seen, the automation's newest run counts if it started after the click.
 */
export async function awaitRunAfterDrop(
    automationId: string | null | undefined,
    knownRunId: string | null,
    clickedAt: number,
): Promise<{ run: DryRun | null; steps: Array<{ stepId: string }> } | null> {
    if (!automationId) return null;
    const getJson = async (url: string) => {
        try {
            const r = await authFetch(url);
            return r.ok ? await r.json().catch(() => null) : null;
        } catch { return null; }
    };
    let runId = knownRunId;
    if (!runId) {
        const j = await getJson(`${API_BASE}/api/automation/${encodeURIComponent(automationId)}/runs?limit=1`);
        const run = Array.isArray(j?.runs) ? j.runs[0] : null;
        if (run?.id && run.startedAt && new Date(run.startedAt).getTime() >= clickedAt - 5000) runId = run.id;
    }
    if (!runId) return null;
    const deadline = Date.now() + DROP_WAIT_MS;
    let run: DryRun | null = null;
    while (Date.now() < deadline) {
        const j = await getJson(`${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}`);
        run = (j?.run as DryRun) || null;
        if (run && RUN_DONE(run.status)) break;
        await new Promise(res => setTimeout(res, DROP_POLL_MS));
    }
    if (!run || !RUN_DONE(run.status)) return null;
    const js = await getJson(`${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/steps`);
    return { run, steps: Array.isArray(js?.steps) ? js.steps : [] };
}

export function settleRunStub(d: DryRun | null): DryRun | null {
    return d && d.status === 'running' ? { ...d, status: 'error' } : d;
}

/**
 * Replace one step's run row with an error row after a failed "Execute step".
 *
 * A failed execute used to leave the PREVIOUS run's row in place, so the panel
 * kept showing that run's output under a green "Success" badge — the user reads
 * it as the result of the run that just failed (BFSF-360). We deliberately do
 * not reuse the old row's fields: `output`, `durationMs`, `runId` and friends
 * all belong to the attempt that succeeded, and only the error is true now.
 * status 'error' is the same value the server records, so the red node border
 * and NodeDetailView's "Retry from here" light up as they would for a run-time
 * failure.
 *
 * Sub-rows recorded by this step's flowlet internals are namespaced
 * `<stepId>/<subStepId>` by the runner (recursively, e.g. `cl1/cl2/out`), so
 * they belong to the same superseded attempt and go with it.
 */
export function markStepFailed(steps: unknown, stepId: string, error?: string) {
    const rows = Array.isArray(steps) ? steps : [];
    if (!stepId) return rows;
    const prefix = `${stepId}/`;
    const failed = { stepId, parentStepId: null, status: 'error', error: error || 'Execute step failed', output: null };
    const out = [];
    let replaced = false;
    for (const st of rows) {
        if (!st) continue;
        if (st.stepId === stepId && !st.parentStepId) { out.push(failed); replaced = true; continue; }
        if (typeof st.stepId === 'string' && st.stepId.startsWith(prefix)) continue;
        out.push(st);
    }
    if (!replaced) out.push(failed);
    return out;
}
