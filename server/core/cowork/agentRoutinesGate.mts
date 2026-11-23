/**
 * May this organisation's agent still run on a schedule? Asked at every run of a Cowork item as its agent
 * (./agentScheduleRun.js).
 *
 * The routes that create and change an item already refuse an agent without the `agent_routines` feature, but an
 * organisation that had it and switched it off would keep running the items it scheduled earlier. So the feature is
 * read again at the run, and the answer is one of three:
 *
 *   - allowed: the run goes on;
 *   - switched off: the run is closed as an error, and nothing runs;
 *   - no answer (the feature service did not respond): nobody's failure. The attempt is not spent: its claim is given
 *     back (stores/coworkClaims.mts releaseRun), so the next tick, a minute later, tries again. A schedule left on
 *     'running' would be skipped by the due query until the reaper closed its row as a failure. A run started by an
 *     event keeps its row: its caller closes it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { info: (msg: string) => void; warn: (msg: string) => void };

type HasFeature = (orgId: string, feature: string) => Promise<boolean>;

export interface GateStore {
    markError: (id: string, error: string, close?: { runId?: string | null }) => Promise<unknown>;
    releaseRun?: (scheduleId: string, runId: string | null) => Promise<unknown>;
}

export interface GateOpts {
    /** The history row this attempt opened. */
    runId?: string | null;
    /** The run was started by an event (a mail), not by the clock or a person. */
    eventRun?: boolean;
    /** The feature lookup; without it the entitlement service is read. */
    orgHasBetaFeature?: HasFeature;
}

const FEATURE = 'agent_routines';

function defaultLookup(): HasFeature {
    return (nodeRequire('../entitlements/betaFeatures') as { orgHasBetaFeature: HasFeature }).orgHasBetaFeature;
}

/** False when the run must not go on (the reason is handled here, see the header). */
export async function agentRoutinesAllowed(
    task: { id: string },
    agent: { organization_id?: string | null },
    store: GateStore,
    { runId = null, eventRun = false, orgHasBetaFeature }: GateOpts = {},
): Promise<boolean> {
    if (!agent.organization_id) return true;
    try {
        const allowed = await (orgHasBetaFeature ?? defaultLookup())(agent.organization_id, FEATURE);
        if (allowed) return true;
        await store.markError(task.id, 'agent_routines beta disabled for organisation', { runId });
        log.info(`[AITaskRunner] skipped schedule ${task.id}: agent_routines disabled for org ${agent.organization_id}`);
        return false;
    } catch (e) {
        if (!(e instanceof Error) || e.name !== 'FeatureServiceUnavailableError') throw e;
        log.warn(`[AITaskRunner] beta lookup degraded, deferring schedule ${task.id}: ${e.message}`);
        if (!eventRun) await store.releaseRun?.(task.id, runId);
        return false;
    }
}
