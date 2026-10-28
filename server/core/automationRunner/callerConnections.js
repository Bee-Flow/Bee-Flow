// @typecheck
/**
 * `definition.runPolicy.connections = 'caller'`: a run that somebody other than
 * the owner started (a shared user pressing Run, an agent calling the
 * automation for a person) uses THAT person's integration connections and
 * never the owner's.
 *
 * Today every run executes as the owner (execution.js resolves the owner's
 * session), so a shared or agent-called automation acts in the owner's mailbox,
 * calendar and drive. This option swaps the identity the integration
 * steps dispatch under for the starter's own, and refuses the run before step 1
 * when the starter lacks a connection the flow needs. It only ever NARROWS:
 * with the option off, or when the owner starts the run, nothing changes.
 *
 * The starter is `startedByUserId`, which the routes and the agent dispatcher
 * take from the server-side session, never from a request body or a trigger
 * payload. A run with no recorded starter (schedule, webhook, public form)
 * has nobody to act as and keeps the owner's identity.
 *
 * Pure helpers plus one run-failing step; collaborators from the server's
 * import cycle arrive through `deps` (lint:scc-ratchet).
 */

const log = require('../../telemetry/log');
const { writeRunOutcome, withLastOutput } = require('./runFinalize');
const { PERSONAL_PROVIDERS, collectRequirements } = require('./callerRequirements');
const LABELS = Object.freeze({ google: 'Google', microsoft: 'Microsoft', nextcloud: 'Nextcloud', withings: 'Withings' });
const ERROR_CLASS = 'caller_not_connected';
const UNAVAILABLE_CLASS = 'caller_identity_unavailable';

class CallerNotConnectedError extends Error {
    /** @param {string} provider */
    constructor(provider) {
        const label = LABELS[provider] || provider;
        super(`Connect ${label} first: this automation runs with the connections of the person who starts it, and you have not connected ${label}.`);
        this.name = 'CallerNotConnectedError';
        this.errorClass = ERROR_CLASS;
        this.provider = provider;
    }
}

/**
 * Starts nobody stands behind: the system fires them (a timer, an inbound call,
 * an event, an anonymous form visitor, an inbound mail). Every OTHER start is a
 * person's, so in caller mode it must name them: a caller that forgets fails
 * closed instead of falling back to the owner's connections.
 */
const SYSTEM_TRIGGER_KINDS = Object.freeze(['schedule', 'cron', 'webhook', 'app_event', 'form', 'email']);

/**
 * The user whose connections the run must use, or null when the owner's stay.
 * `lockedMode` is the mode a continued run was started in: a run that began on
 * the caller's connections keeps them whatever the setting says now.
 *
 * @param {{ connections?: string }} policy       resolveRunPolicy output
 * @param {{ userId?: string }} automation
 * @param {string|null|undefined} startedByUserId
 * @param {string|null} [lockedMode]
 * @returns {string|null}
 */
function callerOnlyUserId(policy, automation, startedByUserId, lockedMode = null) {
    const wanted = (policy && policy.connections === 'caller') || lockedMode === 'caller';
    if (!wanted) return null;
    if (!startedByUserId || typeof startedByUserId !== 'string') return null;
    if (startedByUserId === automation?.userId) return null;
    return startedByUserId;
}

/**
 * A start that is not the system's but names nobody, under the caller policy.
 * @param {string} triggerKind
 */
function refusesMissingStarter(policy, triggerKind, startedByUserId, lockedMode = null) {
    const wanted = (policy && policy.connections === 'caller') || lockedMode === 'caller';
    return !!wanted && !startedByUserId && !SYSTEM_TRIGGER_KINDS.includes(triggerKind);
}

/**
 * Does this session carry a working connection for the provider?
 * @param {string} provider
 */
function sessionHasProvider(session, provider) {
    if (!session) return false;
    if (session.automationProviders?.[provider]?.accessToken) return true;
    // Legacy warm session row: one primary provider.
    if (session.oauthProvider === provider && session.accessToken) return true;
    // Connector-bound users reach Nextcloud through the ExApp proxy.
    return provider === 'nextcloud' && !!session.connectorNcUid;
}

/**
 * @param {string} message
 */
function unavailable(message) {
    return Object.assign(new Error(message), { errorClass: UNAVAILABLE_CLASS });
}

/**
 * The identity the run's tool steps use instead of the owner's: the caller's
 * own session, groups, org role and organisation, read fresh. The organisation
 * must be the run's own, or the run fails closed.
 *
 * @returns {Promise<{ userId: string, session: any|null, orgId: string|null, userGroupIds: string[], orgRole: string|null, homeOrgId: string|null, isAdmin: boolean }>}
 * @param {string} callerUserId
 * @param {string | null} runOrgId
 */
async function buildCallerIdentity(deps, callerUserId, runOrgId) {
    const user = await deps.loadUserStore().getUser(callerUserId);
    if (!user) throw unavailable('Your account could not be found, so this automation did not start.');
    const orgId = user.organizationId || null;
    if (orgId !== (runOrgId || null)) {
        throw unavailable('This automation belongs to another organisation than your account, so it did not start.');
    }
    const userGroupIds = await deps.loadAudience().resolveUserGroups(callerUserId);
    const session = await deps.engine.resolveUserSession(callerUserId);
    return {
        userId: callerUserId, session, orgId, userGroupIds: userGroupIds || [],
        orgRole: user.orgRole || null, homeOrgId: user.organizationId || null,
        isAdmin: !!(user.isAdmin || user.role === 'admin'),
    };
}

/**
 * Throws the refusal for the first thing the flow needs that the caller lacks.
 * Nothing here ever consults the owner.
 * @param {{ providers: string[]; httpConnections: Array<{ stepId: string; connectionId: string; }>; usesTools: boolean; destinations: string[]; }} requirements
 */
async function assertCallerReady(deps, identity, automation, requirements) {
    if (requirements.usesTools && !identity.session) {
        throw unavailable('Your connections could not be loaded, so this automation did not start. Try again in a moment.');
    }
    for (const provider of requirements.providers) {
        if (!sessionHasProvider(identity.session, provider)) throw new CallerNotConnectedError(provider);
    }
    if (requirements.httpConnections.length) {
        const store = deps.loadConnectionStore();
        for (const { stepId, connectionId } of requirements.httpConnections) {
            const verdict = await store.authorizeConnectionUse({
                connectionId, runningUserId: identity.userId,
                runningUserOrgId: identity.orgId, runningUserGroups: identity.userGroupIds,
            });
            if (!verdict || !verdict.ok) {
                throw Object.assign(
                    new Error(`The saved credential that step ${stepId || 'an HTTP step'} uses is not available to you, so this automation did not start. Ask the owner to give you access to it.`),
                    { errorClass: ERROR_CLASS },
                );
            }
        }
    }
}

/**
 * Throws the 'open it once and confirm' refusal until this person has acknowledged the current notice.
 * @param {string} callerUserId
 */
async function assertNoticeAcknowledged(deps, automation, callerUserId) {
    const { describeCallerNotice, NOTICE_REQUIRED_CLASS, NOTICE_REQUIRED_MESSAGE } = require('./callerNoticeText');
    const notice = await describeCallerNotice({ automation, userId: callerUserId, store: deps.automationStore, providerForTool: deps.loadConnectionResolution().providerForTool, loadBlockDefinition: deps.loadBlockDefinition, stepProviders: (s) => deps.loadStepProviders(s, { orgId: automation.organizationId || null, userId: automation.userId }) });
    if (notice.applies && !notice.seen) throw Object.assign(new Error(NOTICE_REQUIRED_MESSAGE), { errorClass: NOTICE_REQUIRED_CLASS });
}

/**
 * Fail the run before step 1 (same shape as the Privacy Shield block): the
 * run row ends in error with a stable class, the marker is released.
 *
 * @returns {Promise<any>} the failed run row
 */
async function failRunBeforeSteps(deps, { error, run, heartbeatTimer, startedAt, automation, ownsMarker, emitLifecycle }) {
    const { automationStore, clearRunCancellation } = deps;
    clearRunCancellation(run.id);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const errorClass = error.errorClass || ERROR_CLASS;
    await automationStore.updateRun(run.id, {
        status: 'error', finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: error.message, errorClass,
        summary: `Failed: ${error.message}`,
    }).catch((e) => log.warn(`[AutomationRunner] could not mark run ${run.id} failed: ${e.message}`));
    await writeRunOutcome(deps, {
        runId: run.id, status: 'error', definition: automation.definition,
        error: { message: error.message, errorClass },
    });
    if (ownsMarker) {
        await automationStore.updateAutomation(automation.id, {
            lastStatus: 'error', lastRunAt: new Date().toISOString(),
        }, automation.userId).catch((e) => log.warn(`[AutomationRunner] could not stamp automation ${automation.id}: ${e.message}`));
        await automationStore.releaseAutomation(automation.id)
            .catch((e) => log.warn(`[AutomationRunner] could not release automation ${automation.id}: ${e.message}`));
    }
    emitLifecycle('run.failed', { status: 'error', errorClass, error: error.message, durationMs: Date.now() - startedAt });
    return withLastOutput(await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'error' })), null);
}

/**
 * The run-start gate. Returns `{ identity: null, failedRow: null }` when the
 * option does not apply, `{ identity }` when the caller's own identity is in
 * place (stored on ctx.callerOnly by the caller), or `{ failedRow }` when a
 * live run was refused. Every failure to build the identity fails closed.
 *
 * @param {CallerDeps} deps
 * @param {{ callerUserId: string|null, missingStarter?: boolean, automation: any, runOrgId: string|null,
 *           effectiveMode: string, locked?: boolean, failCtx: any }} args
 */
async function applyCallerOnly(deps, { callerUserId, missingStarter = false, automation, runOrgId, effectiveMode, locked = false, failCtx }) {
    /**
     * @param {Error & { errorClass: string; }} error
     */
    const fail = async (error) => ({ identity: null, failedRow: await failRunBeforeSteps(deps, { ...failCtx, error }) });
    if (missingStarter) {
        return fail(Object.assign(new Error('This automation runs with the connections of the person who starts it, and this start did not say who that is, so it did not start.'), { errorClass: UNAVAILABLE_CLASS }));
    }
    if (!callerUserId) return { identity: null, failedRow: null };
    let identity;
    try {
        identity = await buildCallerIdentity(deps, callerUserId, runOrgId);
    } catch (e) {
        // Fail closed: never carry on as the owner because the caller's
        // connections could not be read.
        log.warn(`[AutomationRunner] caller identity unavailable for automation ${automation.id}: ${/** @type {Error} */ (e).message}`);
        return fail(e.errorClass ? e : unavailable('Your connections could not be loaded, so this automation did not start. Try again in a moment.'));
    }
    // A dry run has no side effects: it dispatches as the caller, but a missing
    // connection falls back to the sample like any "not connected" in a dry run.
    if (effectiveMode === 'dry_run') return { identity, failedRow: null };
    try {
        const lookups = {
            providerForTool: deps.loadConnectionResolution().providerForTool,
            loadBlockDefinition: deps.loadBlockDefinition,
            stepProviders: (aiStep) => deps.loadStepProviders(aiStep, { orgId: runOrgId, userId: automation.userId }),
        };
        const requirements = await collectRequirements(automation.definition, lookups);
        await assertCallerReady(deps, identity, automation, requirements);
        // The one-time notice, for EVERY start that names a person (a Run button,
        // an app, a page, an agent, a skill). A run continuing one that was
        // already underway has been through it.
        if (!locked) await assertNoticeAcknowledged(deps, automation, callerUserId);
    } catch (e) {
        if (!e.errorClass) {
            log.warn(`[AutomationRunner] caller pre-check failed for automation ${automation.id}: ${/** @type {Error} */ (e).message}`);
            return fail(unavailable('Your connections could not be checked, so this automation did not start. Try again in a moment.'));
        }
        return fail(e);
    }
    return { identity, failedRow: null };
}

module.exports = {
    CallerNotConnectedError, ERROR_CLASS, UNAVAILABLE_CLASS, PERSONAL_PROVIDERS, SYSTEM_TRIGGER_KINDS,
    callerOnlyUserId, refusesMissingStarter, collectRequirements, sessionHasProvider, buildCallerIdentity,
    assertCallerReady, failRunBeforeSteps, applyCallerOnly,
};

/**
 * What execution.js hands in (its RUN_DEPS): RunDeps plus the caller lookups.
 * @typedef {import('./runSetup').RunDeps & {
 *   loadConnectionResolution: () => typeof import('../integrations/connectionResolution'),
 *   loadConnectionStore: () => typeof import('../../stores/integrationConnectionStore'),
 *   loadBlockDefinition: ReturnType<typeof import('./callerLookups').blockDefinitionLoader>,
 *   loadStepProviders: ReturnType<typeof import('./callerLookups').stepProvidersLoader>,
 * }} CallerDeps
 */

/** @typedef {import('./runSetup').RunAutomation} RunAutomation */

/** @typedef {Awaited<ReturnType<typeof buildCallerIdentity>>} CallerIdentity */
