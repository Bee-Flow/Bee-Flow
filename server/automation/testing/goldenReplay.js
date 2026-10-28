// @typecheck noImplicitAny
'use strict';
/**
 * Golden runs: replay a saved run as a DRY RUN of the automation as it is now,
 * and compare the result with the saved run.
 *
 * A golden is a finished, successful run somebody marked as "this is what
 * right looks like" (routes/automation/goldens.js). Replaying it feeds the
 * automation the same trigger payload and the same form answers the saved run
 * had (formAnswers.answersFromJourney), runs it in dry-run mode (side effects
 * simulated, reads live), and diffs the two journeys (runCompare.js). The
 * verdict lands on the golden as its `last_replay`:
 *
 *   { status: 'same'|'soft'|'changed'|'error', summary, replayRunId, errorCode }
 *
 * `summary` is the compare's step COUNTS and `errorCode` a short code. Neither
 * holds a value, so the golden row stays free of respondent data.
 *
 * Privacy and lifetime: the saved run's data is only read through the same
 * run-access rules as the run page (the compare restricts itself to legs the
 * viewer may read), and a golden is refused on runs that used the starter's
 * own connections and on PRD automations when it is made. Goldens follow run
 * retention: the row cascades from automation_runs, so when the run is
 * reaped its golden goes with it.
 *
 * replayGoldens never throws: a golden that cannot be replayed ends as
 * status 'error' with a code, and the others carry on.
 */

const { envCap } = require('../mcpRunReadCaps');
const { canReadRunData } = require('../../core/automationModel/callerRunVisibility');

const staleMs = () => envCap('AUTOMATION_GOLDEN_REPLAY_STALE_MS', 30 * 60 * 1000);

/**
 * The status to show for a golden's last replay. A replay still marked
 * 'running' long after it started was cut off (the process died): it reads as
 * 'interrupted' once AUTOMATION_GOLDEN_REPLAY_STALE_MS has passed (0 = never).
 *
 * @param {{ status: string, at?: string|Date|null }|null|undefined} lastReplay
 * @param {number} [now]
 * @returns {string|null}
 */
function effectiveStatus(lastReplay, now = Date.now()) {
    if (!lastReplay || !lastReplay.status) return null;
    if (lastReplay.status !== 'running') return lastReplay.status;
    const limit = staleMs();
    const at = lastReplay.at ? new Date(lastReplay.at).getTime() : NaN;
    if (limit > 0 && Number.isFinite(at) && now - at > limit) return 'interrupted';
    return 'running';
}

/**
 * One saved golden run as the store lists it.
 * @typedef {{ id: string, runId: string, ignorePaths?: string[], lastReplay?: { status: string, at?: string | Date | null } | null }} Golden
 */

/**
 * Is any of these goldens being replayed right now (and not stale)?
 * @param {Golden[] | null | undefined} goldens
 * @param {number} [now]
 */
function anyRunning(goldens, now = Date.now()) {
    return (goldens || []).some((g) => effectiveStatus(g.lastReplay, now) === 'running');
}

/** @param {{ code?: unknown, errorClass?: unknown } | null | undefined} e */
const codeOf = (e) => {
    const c = e && (e.code || e.errorClass);
    return typeof c === 'string' && /^[a-z0-9_]{1,60}$/i.test(c) ? c : 'replay_failed';
};

/**
 * The trigger the replay enters through: the saved run's, if it still exists, else the primary one.
 * @param {ReplayDeps['runEntry']} runEntry
 * @param {{ definition?: any }} automation
 * @param {{ rootStepId?: string | null }} goldenRun
 */
async function resolveEntry(runEntry, automation, goldenRun) {
    const def = await runEntry.entryDefinitionOf(automation);
    let entered = goldenRun.rootStepId ? runEntry.resolveTriggerStepId(def, goldenRun.rootStepId) : null;
    if (!entered || entered.error) entered = runEntry.resolveTriggerStepId(def, null);
    if (!entered || entered.error) throw Object.assign(new Error('no trigger to enter through'), { code: 'trigger_missing' });
    return entered.rootStepId;
}

/**
 * What replayGoldens resolves its collaborators to (the real modules, unless overridden).
 * @typedef ReplayDeps
 * @property {typeof import('../../stores/automationStore')} store
 * @property {{ setGoldenReplay: (id: string, state: Record<string, unknown>) => unknown }} testingStore
 * @property {typeof import('../../core/automationRunner').executeAutomation} executeAutomation
 * @property {typeof import('./formAnswers').answersFromJourney} answersFromJourney
 * @property {{ entryDefinitionOf: typeof import('../../core/automationRunner/entryPoint').entryDefinitionOf, resolveTriggerStepId: typeof import('../../core/automationRunner/entryPoint').resolveTriggerStepId }} runEntry
 * @property {typeof import('./runCompare').compareRuns} compareRuns
 * @property {{ warn: (msg: string) => void }} log
 */
/** @typedef {{ store: typeof import('../../stores/automationStore'), testingStore: { setGoldenReplay: (id: string, state: Record<string, unknown>) => unknown }, executeAutomation: typeof import('../../core/automationRunner').executeAutomation, answersFromJourney: typeof import('./formAnswers').answersFromJourney, runEntry: { entryDefinitionOf: typeof import('../../core/automationRunner/entryPoint').entryDefinitionOf, resolveTriggerStepId: typeof import('../../core/automationRunner/entryPoint').resolveTriggerStepId }, compareRuns: typeof import('./runCompare').compareRuns, log: { warn: (msg: string) => void } }} ReplayDeps */

/**
 * Replay one golden; the outcome is written on the golden.
 * @param {Golden} golden
 * @param {{ automation: any, userId: string, aiAnswers?: 'live'|'cache' }} input
 * @param {ReplayDeps} deps
 */
async function replayOne(golden, input, deps) {
    const { automation, userId, aiAnswers } = input;
    const { store, testingStore, log } = deps;
    let replayRunId = null;
    try {
        await testingStore.setGoldenReplay(golden.id, { status: 'running', summary: null, replayRunId: null, errorCode: null });
        const goldenRun = await store.getRun(golden.runId);
        if (!goldenRun) throw Object.assign(new Error('the saved run is gone'), { code: 'golden_run_gone' });
        const legs = (await store.getRunsInChain(goldenRun.id).catch(() => [goldenRun])) || [goldenRun];
        const steps = await store.getRunStepsForChain(goldenRun.id);
        const definition = (await store.getVersionDefinition(goldenRun.automationId, goldenRun.version)) || automation.definition;
        const answers = deps.answersFromJourney({ definition, rootRun: goldenRun, steps });
        const rootStepId = await resolveEntry(deps.runEntry, automation, goldenRun);

        const replay = await deps.executeAutomation(automation, {
            triggerKind: 'dry_run',
            mode: 'dry_run',
            triggerPayload: goldenRun.triggerPayload ?? null,
            rootStepId,
            startedByUserId: userId,
            harness: { source: { kind: 'golden', id: golden.id }, formAnswers: { pages: answers.pages }, aiAnswers },
        });
        replayRunId = replay.id;
        const replayLegs = (await store.getRunsInChain(replay.id).catch(() => [replay])) || [replay];

        const result = await deps.compareRuns({
            runA: goldenRun, runB: replay,
            legsA: legs.filter((/** @type {Parameters<typeof canReadRunData>[0]} */ l) => canReadRunData(l, userId)),
            legsB: replayLegs.filter((/** @type {Parameters<typeof canReadRunData>[0]} */ l) => canReadRunData(l, userId)),
            viewerId: userId, ignorePaths: golden.ignorePaths || [],
        });
        await testingStore.setGoldenReplay(golden.id, { status: result.verdict, summary: result.summary, replayRunId, errorCode: null });
        return { goldenId: golden.id, status: result.verdict };
    } catch (e) {
        const errorCode = codeOf(e);
        // The code only: an error message can carry a value.
        log.warn(`[automation/goldenReplay] replay of ${golden.id} failed (${errorCode})`);
        await Promise.resolve(testingStore.setGoldenReplay(golden.id, { status: 'error', summary: null, replayRunId, errorCode }))
            .catch(() => log.warn(`[automation/goldenReplay] could not record the failure of ${golden.id}`));
        return { goldenId: golden.id, status: 'error' };
    }
}

/**
 * @param {{ automation: any, goldens: any[], userId: string, aiAnswers?: 'live'|'cache' }} input
 * @param {Partial<ReplayDeps> & { concurrency?: number }} [overrides]
 * @returns {Promise<Array<{ goldenId: string, status: string }>>}
 */
async function replayGoldens(input, overrides = {}) {
    const deps = {
        store: overrides.store || require('../../stores/automationStore'),
        testingStore: overrides.testingStore || {
            setGoldenReplay: (/** @type {Parameters<typeof import('../../stores/automationTestingStore').setGoldenReplay>} */ ...a) => require('../../stores/automationTestingStore').setGoldenReplay(...a),
        },
        executeAutomation: overrides.executeAutomation || ((/** @type {Parameters<typeof import('../../core/automationRunner').executeAutomation>} */ ...a) => require('../../core/automationRunner').executeAutomation(...a)),
        answersFromJourney: overrides.answersFromJourney || ((/** @type {Parameters<typeof import('./formAnswers').answersFromJourney>[0]} */ input) => require('./formAnswers').answersFromJourney(input)),
        runEntry: overrides.runEntry || {
            entryDefinitionOf: (/** @type {Parameters<typeof import('../../core/automationRunner/entryPoint').entryDefinitionOf>} */ ...a) => require('../../core/automationRunner/entryPoint').entryDefinitionOf(...a),
            resolveTriggerStepId: (/** @type {Parameters<typeof import('../../core/automationRunner/entryPoint').resolveTriggerStepId>} */ ...a) => require('../../core/automationRunner/entryPoint').resolveTriggerStepId(...a),
        },
        compareRuns: overrides.compareRuns || ((/** @type {Parameters<typeof import('./runCompare').compareRuns>[0]} */ input) => require('./runCompare').compareRuns(input)),
        log: overrides.log || require('../../telemetry/log'),
    };
    const goldens = input.goldens || [];
    const configured = overrides.concurrency ?? envCap('AUTOMATION_GOLDEN_REPLAY_CONCURRENCY', 2);
    const workers = Math.max(1, Math.min(goldens.length || 1, configured > 0 ? configured : goldens.length));
    const full = { ...input, aiAnswers: /** @type {'cache'|'live'} */ (input.aiAnswers === 'cache' ? 'cache' : 'live') };

    const results = new Array(goldens.length);
    let next = 0;
    const worker = async () => {
        while (next < goldens.length) {
            const i = next++;
            results[i] = await replayOne(goldens[i], full, deps);
        }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}

module.exports = { replayGoldens, effectiveStatus, anyRunning };
