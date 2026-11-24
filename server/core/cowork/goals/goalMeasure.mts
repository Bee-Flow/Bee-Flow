/**
 * Measuring a goal: after a run of a cowork ends, its approved check (./goalCheck.mts) is run once and its two numbers
 * are kept (stores/coworkGoals.mts), so the cowork reports on the goal and not only on whether it ran.
 *
 *   - READ-ONLY. The check runs as the automation runner's dry run: every step of a check only reads (the rules say
 *     so, and are asked again here, before the run), and a dry run simulates whatever would change or send anything
 *     all the same. Nobody answers a pause: a check holds no step that waits for one.
 *   - AS APPROVED. The definition the owner approved is what runs, not the check's automation of the moment.
 *   - COALESCED. At most one measurement per item per window (MEASURE_WINDOW_MS): runs that end close together are
 *     measured once, claimed in the store, so two servers agree.
 *   - APART. A check that fails, or throws, never touches the cowork's run: the run has ended and said so before this
 *     starts. The failure is kept as a measurement with `ok = false` and a short reason the owner can read.
 *
 * Heard through ../runEnded.mts. `start()` is called from boot (boot/startupJobs.js): requiring this module starts
 * nothing.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../plan/planTypes.mts';
import type { CoworkGoalsStore } from '../../../stores/coworkGoals.mts';
import { withIsolatedScripts } from '../plan/planRunCopy.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../plan/planSource.mts';
import { onRunEnded, type EndedItem } from '../runEnded.mts';
import { countOf, goalCheckFindings } from './goalCheck.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** One measurement per item per this long. */
export const MEASURE_WINDOW_MS = 15 * 60_000;

type AutomationRow = SourceRow;
interface RunRow { id?: string; status?: string; error?: string | null; lastOutput?: unknown }

export interface MeasureDeps {
    store: Pick<CoworkGoalsStore, 'getGoal' | 'claimMeasurement' | 'recordResult'>;
    getAutomation: (id: string) => Promise<AutomationRow | null>;
    /** The automation is managed by a Solution stage: it would not run as approved (../plan/planSource.mts). */
    isManaged: (automation: AutomationRow) => Promise<boolean>;
    executeAutomation: (automation: AutomationRow, opts: Record<string, unknown>) => Promise<RunRow | null | undefined>;
    lookups: ToolLookups;
    now: () => Date;
}

const defaults = (): MeasureDeps => ({
    store: (nodeRequire('../../../stores/coworkGoals.mts') as typeof import('../../../stores/coworkGoals.mts')).coworkGoals(),
    getAutomation: (id) => (nodeRequire('../../../stores/automationStore') as { getAutomation: MeasureDeps['getAutomation'] }).getAutomation(id),
    isManaged: isManagedByStage,
    executeAutomation: (a, o) => (nodeRequire('../../automationRunner') as { executeAutomation: MeasureDeps['executeAutomation'] }).executeAutomation(a, o),
    lookups: (nodeRequire('../plan/planLookups.mts') as typeof import('../plan/planLookups.mts')).toolLookups(),
    now: () => new Date(),
});

export type Measured = 'measured' | 'failed' | 'coalesced' | 'no_check';

/** Thrown inside a measurement for a reason the owner may read as it is. */
class CheckRefused extends Error {}

const REASON_MAX = 200;

/** Run the approved check once, read-only, and answer its count. Throws why it could not tell. */
async function runCheck(item: EndedItem, checkAutomationId: string | null, definition: Definition, deps: MeasureDeps) {
    const findings = goalCheckFindings(definition, deps.lookups);
    if (findings.length > 0) throw new CheckRefused(`The check may not run: ${findings[0]?.message ?? ''}`);
    const automation = await planSourceOf(checkAutomationId, item.userId, deps);
    if (!automation) throw new CheckRefused('The automation of the check is gone or no longer yours.');
    const row = await deps.executeAutomation({ ...automation, definition: withIsolatedScripts(definition) }, {
        // A dry run: what reads runs for real, anything else would be simulated. A check holds nothing else.
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: item.userId, origin: 'api', pausesRequested: false,
    });
    if (row?.status !== 'success') {
        const why = typeof row?.error === 'string' && row.error ? `: ${row.error}` : '';
        throw new CheckRefused(`The check did not finish (${row?.status ?? 'not started'})${why}`.slice(0, REASON_MAX));
    }
    const count = countOf(row.lastOutput);
    if (!count.ok) throw new CheckRefused(count.reason);
    return count;
}

/** Measure the goal of `item` after its run `runId` ended. Never throws: answers what happened. */
export async function measureAfterRun(item: EndedItem, runId: string, deps: MeasureDeps = defaults()): Promise<Measured> {
    const goal = await deps.store.getGoal(item.id);
    if (!goal || !goal.approvedDefinition) return 'no_check';
    const now = deps.now();
    if (!(await deps.store.claimMeasurement(item.id, now, MEASURE_WINDOW_MS))) return 'coalesced';
    try {
        const count = await runCheck(item, goal.checkAutomationId, goal.approvedDefinition as Definition, deps);
        await deps.store.recordResult(item.id, { runId, met: count.met, total: count.total, period: count.period, ok: true, error: null, measuredAt: now });
        return 'measured';
    } catch (e) {
        const reason = e instanceof CheckRefused ? e.message : 'The check could not run. Try it again after the next run.';
        if (!(e instanceof CheckRefused)) log.warn(`[CoworkGoals] the check of ${item.id} failed: ${(e as Error)?.message}`);
        await deps.store.recordResult(item.id, { runId, met: null, total: null, period: null, ok: false, error: reason, measuredAt: now });
        return 'failed';
    }
}

/** The same, for a listener that does not wait: anything left over is logged. */
function measureLater(item: EndedItem, runId: string, deps?: MeasureDeps): void {
    measureAfterRun(item, runId, deps).catch((e: Error) => log.warn(`[CoworkGoals] ${item.id} was not measured: ${e.message}`));
}

let stopListening: (() => void) | null = null;

/** Hear the runs that end (`deps`: a test's). A second start does nothing; answers whether this one started. */
export function start(deps?: MeasureDeps): boolean {
    if (stopListening) return false;
    stopListening = onRunEnded((item, runId) => { setImmediate(() => measureLater(item, runId, deps)); });
    return true;
}

/** Stop hearing them (shutdown, tests). */
export function stop(): void {
    stopListening?.();
    stopListening = null;
}
