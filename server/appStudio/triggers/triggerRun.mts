/**
 * The server run a trigger starts: the ONE server runner (backgroundRun.mts with the job of
 * backgroundRunJob.mts), with origin `trigger` and the trigger's id on the run row.
 *
 * It is the run a background action gets (the heartbeat, the progress, the run log's step rows,
 * a cancel, a pause that resumes, the sweep of a dead process), with three differences: the
 * starter is the app owner (unattendedIdentity.mts built the input), the host refuses every step
 * that may not run unattended (`input.unattended`), and the action need not be marked
 * `background`: a trigger runs any action on the server.
 */

import { ownAction } from '../actionCalls.mts';
import { resolveLockKey } from '../backgroundRun.mts';
import { isShuttingDown, launch, newJob } from '../backgroundRunJob.mts';
import { lockedMessage, withDefaults } from '../backgroundRunParts.mts';
import type { RunnerDeps, StartInput, StartResult } from '../backgroundRunParts.mts';
import { newRunId } from '../../stores/studioAppData/runPolicy.mts';

/** Start the run of trigger `triggerId`, or say why not. Never throws for a refusal. */
export async function startTriggerRun(input: StartInput, triggerId: string, given: Partial<RunnerDeps> = {}): Promise<StartResult> {
    const deps = withDefaults(given);
    if (isShuttingDown()) return { ok: false, status: 503, code: 'shutting_down', error: 'The server is restarting.' };
    const action = ownAction(input.def.actions, input.actionId);
    if (!action || !input.unattended) return { ok: false, status: 400, code: 'not_unattended', error: 'This action cannot be started by a trigger.' };
    const limits = deps.limits();
    const lockKey = await resolveLockKey(input, action, deps);
    const jobId = newRunId();
    const inserted = await deps.store().insertRunningRun({
        id: jobId, appId: input.app.id, ownerUserId: input.app.userId, viewerUserId: input.viewer.id, actionId: input.actionId,
        origin: 'trigger', draft: false, definitionVersion: input.definitionVersion, dryRun: false, lockKey,
        instanceId: deps.instanceId, staleMs: limits.staleMs, triggerId,
    });
    if (!inserted.ok) return { ok: false, status: 409, code: 'action_locked', error: lockedMessage(inserted.holder, deps.now()) };
    launch(newJob(jobId, input, action, deps, limits));
    return { ok: true, jobId };
}
