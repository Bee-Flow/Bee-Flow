// @typecheck
/**
 * Setting a run up (moved verbatim out of execution.js's executeAutomation):
 * which organisation it belongs to, which trigger it entered through, which
 * copy (live or working) it executes, its initial run state, its PII token
 * vault (seeded from the run it continues) and its owner's identity.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const { buildTriggerState } = require('./triggerState');
// Handoff 5: which copy a run executes (live vs working) and the automation's
// run policy (default retry, time budget, concurrency).
const { automationForRun, isTestRun } = require('./definitionForRun');
// Solution stages (design 4.2, D17): the project's variable values over
// definition.vars, and whether an automation is managed by a stage.
const { runVarsFor, isManagedAutomation } = require('./stageVars');

/**
 * Which organisation a run belongs to: the automation's own, else its OWNER's.
 *
 * `automations.organization_id` is never written — routes/automation/crud.js
 * creates with `userId` only — so this was null for every automation ever made,
 * and everything hanging off ctx.orgId ran with no organisation. resolveOrgShield
 * bails on a falsy id, so the org Privacy Shield (including its "Also protect
 * automations" switch, which reads as ON in the settings page) applied to nothing
 * at all. The guardrail audit rows and the audience checks were equally org-less.
 *
 * The owner's org is the same answer every other surface resolves for that
 * person, and resolveUserSession had already read it for its OAuth work — it
 * simply was not being asked for.
 *
 * A fallback, never an override: an automation deliberately scoped to one
 * organisation must not drift to another when its author's membership changes.
 */
function runOrgFor(automation, session) {
    return automation?.organizationId || session?.user?.organizationId || null;
}

/**
 * Which trigger did this run enter through?
 *
 * An automation may declare extra entry points in `definition.triggers[]`; whoever
 * dispatched the run names the one that fired via `rootStepId`. Everything else
 * enters at the primary `definition.trigger`.
 *
 * Hoisted out of the `formBaseTheme` getter it used to live inside, because a
 * second place now needs the same answer (the pinned-sample seeding below) and
 * a hand-written copy of this lookup is exactly how the two would come to
 * disagree about which trigger a run belongs to — one serving trigger A's form
 * theme while the other served trigger B's sample.
 */
function resolveEnteredTrigger(def, rootStepId = null) {
    const triggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])];
    const entered = rootStepId ? triggers.find(t => t?.id === rootStepId) : def?.trigger;
    return entered || def?.trigger || null;
}

/**
 * The copy of the automation this run executes.
 *
 * @returns {Promise<{ automation: object, testRun: boolean }>}
 */
async function selectRunCopy(deps, automation, { mode, triggerKind, isTest }) {
    const { automationStore } = deps;
    // ── Live or working copy (handoff 5) ──────────────────────────────────
    // Test runs (dry run, partial builder runs, the Test button's `isTest`)
    // execute the WORKING copy; every other run executes the LIVE copy when
    // the automation has one. Decided once, here, for every caller — see
    // definitionForRun.js. From this line on `automation.definition` and
    // `automation.version` are the copy this run executes, so the run row
    // records the version that actually ran.
    //
    // An automation managed by a Solution stage (D17) runs its LIVE copy with the
    // live settings, test runs included; with no live copy the run is refused
    // here, before a run row exists (409 managed_part_not_deployed).
    const testRun = isTestRun({ mode, triggerKind, isTest });
    const managed = await isManagedAutomation(automation);
    // A caller-built spread (resume, partial run, a route that selected
    // unmanaged) lost the row's live copy: read it, so the run gets the LIVE
    // settings and a pinned resume can be told apart from the working copy.
    const storeLive = managed && automation && !Object.prototype.hasOwnProperty.call(automation, 'liveDefinition')
        ? await Promise.resolve().then(() => automationStore.getAutomation(automation.id)).catch(() => null)
        : null;
    automation = automationForRun(storeLive ? { ...automation, liveVersion: storeLive.liveVersion ?? null } : automation,
        { mode, triggerKind, isTest, managed, liveDefinition: storeLive?.liveDefinition ?? null });
    return { automation, testRun };
}

/** The run's initial state: trigger, replayed steps, vars, loop seed. */
async function buildRunState(deps, { enteredTrigger, triggerKind, triggerPayload, triggerHeaders, schedule, startedAt, replayState, automation, loopVars }) {
    const { cloneRunValue, MASK_VALUES } = deps.engine;
    const runState = {
        // trigger.output IS the raw trigger payload (for webhooks: the POSTed
        // JSON body — no wrapper). Headers ride OUTSIDE output, at
        // trigger.headers, so they can never collide with body fields and
        // existing trigger.output.<field> bindings stay valid (A14).
        // Beside `output`, the run also learns WHICH trigger fired and how:
        // trigger.kind / .source / .id / .provider / .event / .firedAt /
        // .schedule (triggerState.js). Meta stays outside `output` so the
        // Privacy Shield rewrite below and every payload scan leave it alone.
        trigger: buildTriggerState({ enteredTrigger, triggerKind, triggerPayload, triggerHeaders, schedule, startedAt }),
        // Hydrate from a previous run's recorded outputs when resuming —
        // bindings like {{steps.stepA.output.field}} need the values the
        // original run produced. Deep-clone the replay snapshot so step
        // handlers can't mutate the persisted prior-run rows.
        steps: replayState ? (cloneRunValue(replayState) || {}) : {},
        // definition.vars with the Solution variable values of the automation's
        // project laid over them (stageVars.js; never throws).
        vars: await runVarsFor(automation),
        secrets: {}, // populated by sandbox/secret bridges only; never echoed
        // Symbol-keyed mask needles from http_request credential injection.
        // Unreachable from {{…}} templates / exprs / code steps (string-path
        // walkers); folded into secretValuesFor at the recordRunStep
        // chokepoint. Sub-states share this array by reference.
        [MASK_VALUES]: [],
        // Normally filled per iteration by execLoop / execForEachStep. Seeded
        // up-front for ONE case: a partial run of a step that lives inside a
        // loop body, where the surrounding iteration is what gives the step its
        // input (runPartialInLoopBody).
        loop: loopVars ? (cloneRunValue(loopVars) || {}) : {},
        // When non-null, interpolateTemplate pushes unresolved paths here so
        // the runner can surface a single warning summary per run instead of
        // silently swallowing missing bindings.
        _templateWarnings: [],
        // §WS4: every step failure absorbed by an on_error branch lands here
        // ({stepId, message, errorClass}). Layer/loop/parallel sub-states
        // carry the SAME array reference, so nested handled errors surface
        // in the run summary + handled_error_count too.
        _handledErrors: [],
    };
    return runState;
}

/** The run-scoped PII token vault, seeded from the run being continued. */
async function createRunVault(deps, { parentRunId, run, runOrgId, automation, effectiveMode }) {
    const { automationStore, createTokenVault, defaultPersist } = deps;
    // ── Run-scoped PII token vault ────────────────────────────────────────
    // ONE token namespace for the whole run. Every tokenize call is seeded from
    // it, so a value keeps in node 5 the placeholder it got in node 1, and every
    // restore point holds the complete map — a tokenized value can no longer
    // become unrestorable (which is exactly how `[person_1]` used to end up in
    // outgoing emails). Container steps shallow-copy ctx, so parallel branches,
    // loop iterations and sub-layers all share this same object.
    //
    // Seeded from the run being replayed (approval resume / retry-from-step):
    // that run may have minted placeholders in another process.
    let vaultSeed = null;
    if (parentRunId && typeof automationStore.getRunTokenMap === 'function') {
        vaultSeed = await Promise.resolve(automationStore.getRunTokenMap(parentRunId)).catch(() => null);
    }
    const tokenVault = createTokenVault({
        runId: run.id,
        seed: vaultSeed,
        persist: defaultPersist,
        onEvict: () => {
            // A dropped placeholder is a real (if rare) loss of restorability —
            // audit it instead of only warning to stdout.
            try {
                require('../../stores/guardrailEventStore').logGuardrailEvent({
                    organization_id: runOrgId,
                    user_id: automation.userId || null,
                    agent_id: null,
                    agent_name: automation.title || null,
                    conversation_id: automation.id,
                    automation_id: automation.id,
                    run_id: run.id,
                    step_id: null,
                    source: 'automation',
                    violation_type: 'pii',
                    violation_categories: 'token_evicted',
                    direction: 'output',
                    action_taken: 'redacted',
                    is_dry_run: effectiveMode === 'dry_run',
                }).catch(() => {});
            } catch (_) { /* never fail a run on audit logging */ }
        },
    });
    return tokenVault;
}

/** The owner's groups, org role and home organisation, read once per run. */
async function resolveRunIdentity(deps, automation) {
    const { loadAudience, loadUserStore } = deps;
    // Resolve the automation owner's groups once per run. Used by webpage
    // tools (and any future tool) to check shared/published visibility
    // outside the request-scoped audience helpers.
    let runUserGroupIds = [];
    // The owner's org role and home organisation come from the SAME user read
    // the groups need, so this costs no extra query. A datatable step needs all
    // three: the grade resolver anchors an org-admin role to the org that role
    // was granted in, and orgId alone cannot tell it apart from a role carried
    // over from a previous employer.
    //
    // The HTTP half of this is auth/datatableAccess.resolveDatatablePrincipal.
    // Both read the same three fields fresh from `users`, and they must keep
    // agreeing: the moment one of them starts trusting a session or a run
    // snapshot, an automation can write rows its author cannot see.
    let runUserOrgRole = null;
    let runUserHomeOrgId = null;
    // A FAILURE here is recorded, not swallowed. Tolerating it is right for the
    // webpage tools (an empty group list narrows what they show), and wrong for
    // a datatable: an unresolved orgRole degrades to "not an admin" and an
    // unresolved group list to "in no group", so a step that worked yesterday
    // fails today as `datatable_forbidden` — an authorisation refusal for what
    // is really a lookup outage, with nothing anywhere saying so. execDatatable
    // reads this and fails with `datatable_identity_unavailable` instead.
    let runIdentityError = null;
    try {
        const { resolveUserGroups } = loadAudience();
        runUserGroupIds = await resolveUserGroups(automation.userId);
        const userStore = loadUserStore();
        const owner = await userStore.getUser(automation.userId);
        runUserOrgRole = owner?.orgRole || null;
        runUserHomeOrgId = owner?.organizationId || null;
    } catch (e) { runIdentityError = e?.message || 'identity lookup failed'; }
    return { runUserGroupIds, runUserOrgRole, runUserHomeOrgId, runIdentityError };
}

module.exports = { runOrgFor, resolveEnteredTrigger, selectRunCopy, buildRunState, createRunVault, resolveRunIdentity };
