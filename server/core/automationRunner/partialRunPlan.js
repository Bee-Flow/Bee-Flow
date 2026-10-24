// @typecheck
/**
 * The plan of a seeded partial run (the re-run of a step with the inputs of a
 * chosen run): what would execute, which of it has side effects, and the two
 * refusals that guard it. Split out of partialRuns.js; pure apart from the
 * executor handed to executePartial.
 */

const { buildAdjacency } = require('./shared');
const { reachableFrom, ancestorsOf, descendantsOf } = require('./runDagGraph');
const { withReplayStale } = require('./replaySeeding');
const { stepEffect } = require('../automationModel/stepEffect');
const { HttpError } = require('../http/errors');

/**
 * What a partial run of `targetId` would execute, given the replay state it was
 * seeded with. Pure: no store, no run.
 *
 * It mirrors runDag's own decision (runDag.replayDecision): the target runs; a
 * PREREQUISITE (an ancestor of the target reachable from the entry) with no
 * replayed output is executed live (`missingUpstream`); 'from' also runs every
 * descendant of the target. A pinned step is a replay entry, so it never counts
 * as missing. The list of descendants is an upper bound: a branch the run does
 * not take is still named, which is the safe side for a confirmation.
 *
 * `sideEffects` is built from an explicit allow-list of fields and lists only
 * the steps whose effect is more than a read (automationModel/stepEffect.js).
 *
 * @param {{ trigger?: any, triggers?: any[], steps?: any[], edges?: any[], layers?: any }} graph
 * @param {{ targetId: string, mode: 'only'|'from', rootStepId?: string|null, replayState: Record<string, any> }} q
 */
function planPartialExecution(graph, { targetId, mode, rootStepId = null, replayState }) {
    const steps = Array.isArray(graph.steps) ? graph.steps : [];
    const { adj, incoming, stepById } = buildAdjacency({ trigger: graph.trigger, triggers: graph.triggers, steps, edges: graph.edges });
    const triggerIds = new Set([graph.trigger, ...(Array.isArray(graph.triggers) ? graph.triggers : [])].map(t => t?.id).filter(Boolean));
    const entry = rootStepId || graph.trigger?.id;
    const reachable = entry ? reachableFrom(adj, entry) : new Set();
    const hasData = (id) => {
        const e = replayState && replayState[id];
        return !!e && (e.output != null || e.status === 'handled_error');
    };
    const missing = new Set([...ancestorsOf(incoming, targetId, reachable)]
        .filter(id => !triggerIds.has(id) && stepById.get(id)?.type !== 'note' && !hasData(id)));
    const executes = new Set(missing);
    if (!triggerIds.has(targetId)) executes.add(targetId);
    if (mode === 'from') for (const id of descendantsOf(adj, targetId)) if (!triggerIds.has(id)) executes.add(id);
    const inGraphOrder = (set) => steps.map(s => s?.id).filter(id => id && set.has(id));
    const sideEffects = [];
    for (const id of inGraphOrder(executes)) {
        const step = stepById.get(id);
        const effect = stepEffect(step, { layers: graph.layers });
        if (effect === 'reads') continue;
        sideEffects.push({ stepId: id, type: step.type, tool: typeof step.tool === 'string' ? step.tool : null, label: typeof step.label === 'string' ? step.label : null, effect });
    }
    return { willExecute: inGraphOrder(executes), missingUpstream: inGraphOrder(missing), sideEffects };
}

/**
 * The seeded-rerun options a caller passes, normalised (all off without a seed
 * run). `mode` is checked here: "up to here" executes everything before the
 * target on purpose and replays nothing, so there is no seed to take.
 */
function seedOptions({ seedRunId = null, allowLiveUpstream = false, confirmSideEffects = false, planOnly = false } = {}, mode = undefined) {
    if (planOnly && !seedRunId) throw new Error('runPartial: planOnly needs a seedRunId');
    if (seedRunId && mode === 'upTo') {
        throw new HttpError(400, 'seed_mode_unsupported', 'Taking the inputs of a chosen run works with mode "only" or "from".');
    }
    return { seedRunId: seedRunId || null, allowLiveUpstream: !!allowLiveUpstream, confirmSideEffects: !!confirmSideEffects, planOnly: !!planOnly };
}

/**
 * The plan as the caller sees it: what the seed run is, what would execute, and
 * which of it has side effects. Not persisted: it describes this response.
 */
function describePlan(plan, seedRun, staleFrom) {
    return {
        seedRunId: seedRun?.id || null,
        seedRunVersion: seedRun?.version ?? null,
        seedRunStartedAt: seedRun?.startedAt || null,
        willExecute: plan.willExecute,
        missingUpstream: plan.missingUpstream,
        sideEffects: plan.sideEffects,
        requiresConfirm: plan.sideEffects.length > 0,
        replayStale: Object.entries(staleFrom || {}).map(([stepId, version]) => ({ stepId, version })),
    };
}

/** The plan of a run that executes nothing beyond the trigger itself. */
function emptyPlan(seed) {
    return { seedRunId: seed.seedRunId, seedRunVersion: null, seedRunStartedAt: null, willExecute: [], missingUpstream: [], sideEffects: [], requiresConfirm: false, replayStale: [] };
}

/**
 * The two refusals of a seeded re-run. A step the seed run has no output for
 * would be executed live, which is not "the inputs of that run": refused unless
 * the caller allows it (409 seed_missing_upstream). Whatever would execute and
 * is more than a read needs the caller's explicit yes (409
 * side_effects_need_confirm), so a click never mails or writes by accident.
 */
function enforceSeedPlan(plan, seed) {
    if (plan.missingUpstream.length && !seed.allowLiveUpstream) {
        throw new HttpError(409, 'seed_missing_upstream',
            'The chosen run has no recorded output for some steps this one needs. Allow them to run live, or pick another run.',
            { stepIds: plan.missingUpstream });
    }
    if (plan.sideEffects.length && !seed.confirmSideEffects) {
        throw new HttpError(409, 'side_effects_need_confirm',
            'Running this again would send or write outside the run. Confirm to continue.',
            { steps: plan.sideEffects });
    }
}

/**
 * Execute a partial run, or (planOnly) just report the plan. With a seed run the
 * plan is enforced first; without one this is exactly executeAutomation plus the
 * stale-version tag, as it always was. `execute` is the runner's executeAutomation
 * (late-bound in partialRuns.js, so tests can swap it).
 */
async function executePartial(execute, automation, opts, { seed, plan, staleFrom, seedRun }) {
    const rerunPlan = plan ? describePlan(plan, seedRun, staleFrom) : null;
    if (seed.planOnly) return { rerunPlan };
    if (plan) enforceSeedPlan(plan, seed);
    const run = withReplayStale(await execute(automation, opts), staleFrom);
    return rerunPlan && run ? { ...run, rerunPlan } : run;
}

module.exports = { planPartialExecution, seedOptions, describePlan, emptyPlan, enforceSeedPlan, executePartial };
