/**
 * Automation Builder: the "## Last run" block of a turn (the pure renderer is
 * automation/builderPrompt/lastRun.mts).
 *
 * Which run: the newest run of this automation whose data the person may
 * read, under the rule builder_inspect_run follows (./inspectionTools.js):
 * only the automation's owner, and a run on its starter's own connections
 * only for that starter (callerRunVisibility.canReadRunData). So the block
 * never names a run the model could not then inspect. It is rendered only
 * when that run is newer than the builder session's last write
 * (`snapshot.updatedAt`): a run the assistant already saw in an earlier turn,
 * or ran itself, is not repeated.
 *
 * Privacy: the block holds statuses, step ids and types, error codes and, for
 * a failed step, its error text cut to 200 characters. That text goes through
 * maskedRunValues, the personal-data mask builder_inspect_run puts on run
 * values; when the detector is down or cannot mask, the texts are left out
 * and only the codes remain. No input or output value is read here.
 *
 * Never throws: a store or detector failure leaves the block out.
 */

import { createRequire } from 'node:module';
import { renderLastRun, runIsNewer, summariseRunSteps } from '../../../automation/builderPrompt/lastRun.mts';
import type { RunRow, StepRow } from '../../../automation/builderPrompt/lastRun.mts';

const nodeRequire = createRequire(import.meta.url);

/** How many recent runs are looked through for one this person may read (builder_inspect_run looks through as many). */
const RECENT_RUNS = 10;

type ReadableRun = RunRow & { startedByUserId?: unknown; connectionsMode?: unknown };
export type LastRunStore = {
    getAutomation: (id: string) => Promise<{ userId?: unknown } | null>;
    listRunsForAutomation: (id: string, filters: { limit: number }) => Promise<{ runs?: ReadableRun[] } | null>;
    getRunSteps: (runId: string) => Promise<StepRow[]>;
};
/** The mask: maskedRunValues of ./inspectionTools.js with the detector bound. */
export type MaskValues = (values: unknown) => Promise<{ values?: unknown; valuesAvailable?: boolean }>;
export type LastRunDeps = {
    store: LastRunStore;
    mask: MaskValues;
    canRead: (run: unknown, viewerId: string) => boolean;
    warn: (message: string) => void;
};

function defaultDeps(): LastRunDeps {
    const { maskedRunValues } = nodeRequire('../../../routes/ai/automationBuilder/inspectionTools');
    const log = nodeRequire('../../../telemetry/log');
    return {
        store: nodeRequire('../../../stores/automationStore'),
        // Read at call time, so the detector the process has now is the one used.
        mask: (values) => maskedRunValues(values, nodeRequire('../../../core/privacy/piiDetection')),
        canRead: nodeRequire('../../../core/automationModel/callerRunVisibility').canReadRunData,
        warn: (message) => log.warn(message),
    };
}

/** The failed steps' texts after the mask, by step id; {} when the mask could not run. */
async function maskedMessages(errors: Record<string, string>, mask: MaskValues): Promise<Record<string, string>> {
    const ids = Object.keys(errors);
    if (!ids.length) return {};
    // A list, not an object: the mask masks keys too, and the keys here are the step ids the lines name.
    const out = await mask(ids.map((id) => errors[id]));
    if (!out?.valuesAvailable || !Array.isArray(out.values)) return {};
    const masked = out.values;
    return Object.fromEntries(ids.map((id, i) => [id, masked[i]]).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/**
 * The block for this turn, or null.
 * @param p.since the builder session's last write (`snapshot.updatedAt`)
 * @param p.canInspect the turn offers builder_inspect_run (a work-mode turn)
 */
export async function lastRunBlock(
    { automationId, userId, since, canInspect }: { automationId: string | null | undefined; userId: string; since: unknown; canInspect: boolean },
    deps: LastRunDeps | null = null,
): Promise<string | null> {
    if (!automationId || !userId) return null;
    const d = deps || defaultDeps();
    try {
        const automation = await d.store.getAutomation(automationId);
        if (!automation || automation.userId !== userId) return null;
        const listed = await d.store.listRunsForAutomation(automationId, { limit: RECENT_RUNS });
        const run = (listed?.runs || []).find((r) => d.canRead(r, userId));
        if (!run || typeof run.id !== 'string' || !runIsNewer(run, since)) return null;
        const { steps, errors } = summariseRunSteps(await d.store.getRunSteps(run.id));
        const messages = await maskedMessages(errors, d.mask).catch(() => ({}));
        return renderLastRun(run, steps, messages, { canInspect }) || null;
    } catch (e) {
        d.warn(`[AutomationBuilder] last run left out: ${(e as Error)?.message || e}`);
        return null;
    }
}
