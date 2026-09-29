/**
 * Steps a plan has to include before a routine may run them unattended.
 *
 * Three step families are paid (license/tiers.js, enterprise):
 *
 *   guard, tokenize   the Privacy Shield steps an author places in a routine
 *                     (`automation_privacy_steps`). NOT untokenize: that step
 *                     only puts values back, and taking it away would strand
 *                     placeholders in a routine that already hid them.
 *   approval          a person decides before the run goes on (`approvals`).
 *   fill_document     fills a Studio document from the run's data
 *                     (`studio_documents`).
 *
 * The gate sits where a routine starts to act without its author watching:
 * activation and publishing (routes/automation/activate.js checkBeforeLive),
 * and the builder's test runs of a copy that is not live yet
 * (routes/automation/runs.js, webhooksAndRunOps.js retry, the AI builder's
 * builder_request_dry_run in builderTools.js). It never sits in the runner
 * for the privacy steps, and that asymmetry is the house rule:
 *
 *   - Only NEW creation or WIDENING is refused. A privacy step that is part of
 *     the live version already keeps running after a lapse or a downgrade,
 *     and publishing a new version that still carries it is not widening.
 *     Refusing it would push an author to delete a protective step just to
 *     fix a typo elsewhere, which is the opposite of what the plan is for.
 *   - Approvals and document fills are different because the runner refuses
 *     them already (core/automationRunner/execApproval.js and
 *     execFillDocument.js, errorClass license_required). Letting one go live
 *     on a plan without them would only schedule failures, so every such step
 *     counts, live or not.
 *   - A refusal is a readable 403 naming each step, never a silent skip.
 *
 * Identity of "the same step" is layer + id + type. Switching a live check to
 * "hide" makes it a tokenize step that was never live, so it counts as new.
 *
 * The capability question is asked of the routine's OWNER (steps run as them,
 * automation/access.js), through the same resolver requireCapability uses, so
 * the answer here and on every other surface cannot drift. An outage of that
 * resolver answers 503 entitlement_unavailable, exactly like the middleware,
 * rather than claiming the plan lacks something it may well have.
 */

'use strict';

const { walkSteps } = require('./automationGraph');

const PRIVACY_STEPS = 'automation_privacy_steps';
const APPROVALS = 'approvals';
const DOCUMENTS = 'studio_documents';

/** Step type → the capability it needs. `untokenize` is deliberately absent. */
const STEP_CAPABILITY = Object.freeze({
    guard: PRIVACY_STEPS,
    tokenize: PRIVACY_STEPS,
    approval: APPROVALS,
    fill_document: DOCUMENTS,
});

/** Capabilities whose steps keep their place once they are live. */
const LIVE_KEEPS = new Set([PRIVACY_STEPS]);

const DEFAULT_LABEL = Object.freeze({
    guard: 'Check for personal data',
    tokenize: 'Hide personal data',
    approval: 'Approval',
    fill_document: 'Fill a document',
});

const UPGRADE_URL = process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing';

function isObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Every licensed step in a definition: root graph, loop bodies, parallel
 * branches and every flowlet (automationGraph.walkSteps, which also hands
 * out the validator's own address for each step, so a client that points at
 * the step behind a validation detail points at these too).
 */
function licensedStepsIn(definition) {
    const out = [];
    walkSteps(definition, (node, { path, layer }) => {
        if (!isObject(node)) return;
        const capability = Object.prototype.hasOwnProperty.call(STEP_CAPABILITY, node.type) ? STEP_CAPABILITY[node.type] : null;
        if (!capability) return;
        out.push({
            id: typeof node.id === 'string' && node.id ? node.id : null,
            type: node.type,
            layerKey: layer || null,
            path,
            label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : DEFAULT_LABEL[node.type],
            capability,
        });
    });
    return out;
}

const keyOf = (s) => `${s.layerKey || ''}\u0000${s.id}\u0000${s.type}`;

/**
 * The licensed steps in `definition` that need the licence to go live or run
 * as a test: every approval, and every privacy step that is not in `live`
 * (layer + id + type). `live` null means nothing is live yet.
 *
 * `only` narrows to some capabilities (the test-run gate asks about the
 * privacy steps alone: an approval in a test run already fails in the runner,
 * or previews as approved in a dry run).
 */
function stepsNeedingLicence(definition, live = null, { only = null } = {}) {
    const liveKeys = new Set(isObject(live) ? licensedStepsIn(live).filter(s => s.id).map(keyOf) : []);
    return licensedStepsIn(definition).filter((s) => {
        if (only && !only.includes(s.capability)) return false;
        if (LIVE_KEEPS.has(s.capability) && s.id && liveKeys.has(keyOf(s))) return false;
        return true;
    });
}

/**
 * The live copy of a store row, or null. Read straight off `liveDefinition`
 * (carried non-enumerable by rowToAutomation) and never through
 * definitionForRun: that falls back to the WORKING copy when the live one is
 * missing, which here would exempt every step. Missing means "nothing live".
 */
function liveDefinitionOf(a) {
    if (!a || a.liveVersion == null) return null;
    const live = a.liveDefinition;
    return isObject(live) ? live : null;
}

/**
 * The resolver's answer per capability: 'granted', 'locked' (outside the plan
 * or licence: upgrade), 'disabled' (the plan has it, the organisation or the
 * person was not given it: ask an admin). `{ degraded: true }` when it could
 * not answer. Same distinction as requireCapability's feature_locked /
 * feature_disabled. `ent` is the entitlements module (injectable for tests).
 */
async function resolveCapabilityStates(capIds, { userId = null, orgId = null, session = null } = {}, ent = require('../core/entitlements/entitlements')) {
    const set = await ent.resolveCapabilitySet({ userId, orgId, session });
    if (set.degraded) return { degraded: true, states: {} };
    const states = {};
    for (const id of capIds) {
        if (set.has(id)) { states[id] = 'granted'; continue; }
        const cap = ent.registry.getCapability(id);
        states[id] = cap && inCeiling(set.snapshot, cap.kind, id) ? 'disabled' : 'locked';
    }
    return { degraded: false, states };
}

// The ceiling bucket as a Set when it still is one, else the arrayified copy:
// a snapshot read back from the session cache lost its Sets to JSON (`{}`),
// the same fallback entitlements.snapshotBucketHas makes.
function inCeiling(snapshot, kind, id) {
    const set = snapshot?._sets?.ceiling?.[kind];
    if (set && typeof set.has === 'function') return set.has(id);
    const arr = snapshot?.ceiling?.[kind];
    return Array.isArray(arr) && arr.includes(id);
}

/** The lowest tier that lists this licence feature (license/tiers.js), else enterprise. */
function requiredTierFor(capability) {
    try {
        const tiers = require('../license/tiers');
        return tiers.TIER_HIERARCHY.find(t => tiers.tierHasFeature(t, capability)) || 'enterprise';
    } catch { return 'enterprise'; }
}

/** One step's refusal, in the author's words. */
function detailFor(s, state) {
    const name = `"${s.label}"`;
    if (s.capability === APPROVALS) {
        return {
            code: 'licence.approvals', severity: 'error', path: s.path, stepId: s.id,
            message: state === 'disabled'
                ? `Step ${name} asks a person for approval, and approvals are switched off for your organisation.`
                : `Step ${name} asks a person for approval, and approvals are part of the Enterprise plan.`,
            hint: state === 'disabled'
                ? 'Ask an administrator to switch approvals on, or remove the step.'
                : 'Remove the approval step, or upgrade to Enterprise.',
        };
    }
    return {
        code: 'licence.privacy_steps', severity: 'error', path: s.path, stepId: s.id,
        message: state === 'disabled'
            ? `Step ${name} is a Privacy Shield step, and Privacy Shield steps in routines are switched off for your organisation.`
            : `Step ${name} is a Privacy Shield step, and Privacy Shield steps in routines are part of the Enterprise plan.`,
        hint: state === 'disabled'
            ? 'Ask an administrator to switch them on, or remove the step. Privacy Shield steps that are already live keep running.'
            : 'Remove the step, or upgrade to Enterprise. Privacy Shield steps that are already live keep running.',
    };
}

const LEAD = Object.freeze({
    live: 'This routine cannot go live on your organisation\'s plan.',
    test: 'This routine cannot run with these steps on your organisation\'s plan.',
});

/**
 * The refusal for `steps` (from stepsNeedingLicence), or null when every
 * capability they need is granted.
 *
 * Answers `{ status: 403, body }` in the HttpError shape (core/http/errors.js,
 * the one routes/orgCustomData.js uses for its licence refusal): `error` is a
 * sentence and `code` the machine word, `feature_locked` (outside the plan:
 * upgrade) or `feature_disabled` (in the plan, not given to this organisation:
 * ask an admin), with requireCapability's `feature`, `required` and
 * `upgrade_url` beside it and `details`, one record per step in the
 * validator's shape, so every client that lists activation details lists
 * these. The sentence goes in `error` because that is the field every client
 * shows (the builder's step runs, the phone), and a refusal must read as one
 * wherever it lands. For a test run the step sentences are part of it: those
 * screens show nothing else. `{ status: 503, ... }` when the resolver could not
 * answer, `code: 'entitlement_unavailable'` like the middleware.
 *
 * @param {Array} steps
 * @param {object} who          { userId, orgId, session } of the routine's owner
 * @param {object} [opts]
 * @param {'live'|'test'} [opts.stage]
 * @param {Function} [opts.capabilityStates]  injectable resolveCapabilityStates
 */
async function licenceRefusal(steps, who, { stage = 'live', capabilityStates = resolveCapabilityStates } = {}) {
    if (!Array.isArray(steps) || !steps.length) return null;
    const caps = [...new Set(steps.map(s => s.capability))];
    let answer;
    try { answer = await capabilityStates(caps, who || {}); }
    catch { answer = { degraded: true, states: {} }; }
    if (!answer || answer.degraded) {
        return { status: 503, body: { error: 'The plan could not be checked just now. Try again in a moment.', code: 'entitlement_unavailable', retry_after: 1 } };
    }
    const states = answer.states || {};
    const refused = steps.filter(s => states[s.capability] !== 'granted');
    if (!refused.length) return null;
    // Locked wins over disabled: an upgrade is the bigger step, and an admin
    // cannot switch on what the plan does not include.
    const lockedCap = refused.find(s => states[s.capability] !== 'disabled');
    const first = lockedCap || refused[0];
    const code = lockedCap ? 'feature_locked' : 'feature_disabled';
    const details = refused.map(s => detailFor(s, states[s.capability] === 'disabled' ? 'disabled' : 'locked'));
    const lead = LEAD[stage] || LEAD.live;
    return {
        status: 403,
        body: {
            error: stage === 'test' ? [lead, ...details.map(d => d.message)].join(' ') : lead,
            code,
            feature: first.capability,
            ...(lockedCap ? { required: requiredTierFor(first.capability), upgrade_url: UPGRADE_URL } : {}),
            details,
        },
    };
}

/**
 * The gate a run route asks before it starts `a`: a run that executes the
 * WORKING copy (the builder's Test, a dry run, ▶ Execute, a retry of a test
 * run, or any run of a routine that was never live) is refused when that copy
 * carries a privacy step that is not live. A run of the live copy is never
 * refused here: what is live keeps running.
 *
 * @param {object} a            the store row (with its non-enumerable liveDefinition)
 * @param {object} runOpts      { mode, triggerKind, isTest } as the runner reads them, plus
 *                              `onlyStepId` for a partial run of that one step
 * @param {object} [opts]
 * @param {object} [opts.session]   the caller's session, used only when the caller owns the routine
 * @param {string} [opts.callerId]
 * @param {Function} [opts.capabilityStates]
 */
async function refusalForRun(a, runOpts = {}, { session = null, callerId = null, capabilityStates } = {}) {
    if (!a) return null;
    const { definitionForRun } = require('../core/automationRunner/definitionForRun');
    const { onlyStepId = null, ...forRun } = runOpts || {};
    const chosen = definitionForRun(a, forRun);
    if (chosen.source !== 'working') return null;
    let steps = stepsNeedingLicence(chosen.definition, liveDefinitionOf(a), { only: [PRIVACY_STEPS] });
    if (onlyStepId) steps = steps.filter(s => s.id === onlyStepId);
    if (!steps.length) return null;
    const ownerId = a.userId || callerId || null;
    return licenceRefusal(steps, {
        userId: ownerId,
        orgId: a.organizationId || null,
        session: ownerId && ownerId === callerId ? session : null,
    }, { stage: 'test', ...(capabilityStates ? { capabilityStates } : {}) });
}

/**
 * A refusal as the AI builder's tools answer one: `{ error, code }`, the
 * sentence plus what to do about it, so the model can tell the author rather
 * than retry (builderTools.js builder_request_dry_run).
 */
function refusalAsToolError(refusal) {
    if (!refusal) return null;
    const body = refusal.body || {};
    const hints = [...new Set((body.details || []).map(d => d.hint).filter(Boolean))].join(' ');
    return { error: `${body.error}${hints ? ` ${hints}` : ''}`, code: body.code };
}

module.exports = {
    PRIVACY_STEPS,
    APPROVALS,
    STEP_CAPABILITY,
    licensedStepsIn,
    stepsNeedingLicence,
    liveDefinitionOf,
    resolveCapabilityStates,
    licenceRefusal,
    refusalForRun,
    refusalAsToolError,
};
