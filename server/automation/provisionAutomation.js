/**
 * provisionAutomation — create / activate / tear down an automation automation from
 * server code (no HTTP layer). Used by the Support settings panel to auto-
 * provision the "resolved tickets → knowledge base" automation per inbox.
 *
 * It mirrors the validation + subscription logic of POST /automation/:id/activate
 * (server/routes/automation.js) and reuses the same building blocks
 * (validateDefinition, the permitted-tool catalog, automationStore) so there is
 * one definition of what "active" means.
 *
 * Scope note: the app_event subscription is created in polling mode with no
 * remote (msgraph/github) provisioning. That is correct for the internal
 * `support` provider — its events are dispatched directly in-process via
 * triggerBus.dispatchSupportEvent, which only needs the subscription row to
 * exist. Do NOT use this helper for providers that require remote webhook
 * provisioning; use the automation route's syncAppEventSubscription for those.
 */

const automationStore = require('../stores/automationStore');
const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('./toolRegistry');
const log = require('../telemetry/log');

/** Build the permitted-tool catalog so activation rejects unknown/unpermitted tools. */
async function buildToolCatalog({ userId, session, isAdmin = false }) {
    try {
        const { getUserPermittedApps } = require('../core/integrations/integrationTools');
        const permitted = await getUserPermittedApps({ userId, session, isAdmin: !!isAdmin });
        const availableTools = new Set();
        const toolRequiredParams = {};
        for (const entry of TOOL_REGISTRY) {
            const permittedApp = permitted.has(entry.app);
            for (const t of loadTools(entry)) {
                const name = t?.function?.name;
                if (!name) continue;
                if (permittedApp) availableTools.add(name);
                const rq = t?.function?.parameters?.required;
                if (Array.isArray(rq)) toolRequiredParams[name] = rq;
            }
        }
        return { availableTools, toolRequiredParams };
    } catch (e) {
        log.warn('[provisionAutomation] tool catalog build failed; activating without tool checks:', e.message);
        return { availableTools: null, toolRequiredParams: null };
    }
}

/** Reconcile the app_event subscription row (delete-then-create) in polling mode. */
async function ensureAppEventSubscription(automationId, userId, def) {
    await automationStore.deleteSubscriptionsForAutomation(automationId);
    const trig = def?.trigger;
    if (!trig || trig.kind !== 'app_event') return;
    const provider = trig.appEvent?.provider;
    const event = trig.appEvent?.event;
    if (!provider || !event) return;
    await automationStore.createSubscription({
        automationId, userId, provider, eventType: event,
        mode: 'polling', filter: trig.appEvent?.filter || null,
    });
}

/**
 * Validate + activate an automation and (re)arm its app_event subscription.
 * @throws {Error} with `.details` (validation errors array) when the definition is invalid.
 */
async function activateAutomation(automationId, { userId, session, isAdmin = false }) {
    const a = await automationStore.getAutomation(automationId);
    if (!a) throw new Error('Automation not found');
    // The copy that will RUN (handoff 5 live split): the live one on an automation
    // that has one, else the working copy, which this switch-on publishes
    // (stores/automationStore/lifecycle.js). Checked and subscribed from it.
    const def = require('../core/automationRunner/definitionForRun').definitionForRun(a, { mode: 'live' }).definition || {};
    const { availableTools, toolRequiredParams } = await buildToolCatalog({ userId, session, isAdmin });
    const deliverableEvents = getDeliverableEvents();

    /**
     * ── THE AGENT GATE, ON THE SHARED ACTIVATION PATH ───────────────
     * Same story as the knowledge-base gate below, one release later and one
     * door along. R2 put the `ai_step.agentId` check in the activate ROUTE
     * only (`routes/automation/crud.js`), and every other way of activating a
     * automation walked straight past it: an installed Solution, the Support-inbox
     * toggle, anything else that provisions and activates. The result is the
     * failure this file already describes for knowledge bases — a switch that
     * reports success while the run-time gate refuses the step every night.
     *
     * Asked of the automation's OWNER, because the run happens as them and not as
     * whoever pressed the button, and fail-open as a whole (`null` ⇒ the rule
     * is skipped) for the reason automation/agentCatalog.js gives at length:
     * a lookup outage must not make every automation unactivatable, and the real
     * gate is `resolveStepAgent` at run time.
     */
    let availableAgents = null;
    try {
        const { agentCatalogForOwner } = require('./agentCatalog');
        availableAgents = await agentCatalogForOwner(def, a.userId || userId);
    } catch (e) {
        log.warn('[provisionAutomation] agent catalog build failed; activating without the agent check:', e.message);
        availableAgents = null;
    }

    const topicClassifier = await require('../core/classify/classifierClient').topicClassifierFor(def);
    const v = validateDefinition(def, { availableTools, toolRequiredParams, deliverableEvents, availableAgents, topicClassifier });
    if (!v.ok) { const err = new Error('Invalid definition'); err.details = v.errors; throw err; }

    /**
     * ── THE KNOWLEDGE-BASE GATE, ON THE SHARED ACTIVATION PATH ──────
     * `validateDefinition` is the PURE pass and cannot see a knowledge base —
     * that needs the database. So the gate lived only in the route
     * (`routes/automation/crud.js`), and every other way of activating a
     * automation walked straight past it: the Support-inbox KB toggle, an
     * installed Solution, anything else that provisions and activates.
     *
     * That mattered most on exactly the path K10 created. The Support panel
     * would happily activate an automation whose every run the run-time gate then
     * refused — a switch that reports success and silently does nothing.
     *
     * Checked HERE, where every activation converges, keyed on the automation's
     * OWNER rather than whoever pressed the button.
     */
    try {
        const { kbStepFindings } = require('../core/kb/automationKbCheck');
        const kbErrors = await kbStepFindings(def, {
            orgId: a.organizationId || null,
            userId: a.userId || userId,
            stage: 'activate',
        });
        const blocking = kbErrors.filter(f => f.severity === 'error');
        if (blocking.length) {
            const err = new Error('Invalid definition');
            err.details = blocking;
            throw err;
        }
    } catch (e) {
        // A refusal propagates; an outage in the CHECK does not activate
        // anything it could not verify either — the run-time gate is the
        // backstop, but a switch that silently arms a dead automation is the
        // failure this exists to prevent.
        if (e && e.details) throw e;
        log.warn('[provisionAutomation] knowledge-base check unavailable:', e.message);
    }
    const automation = await automationStore.updateAutomation(automationId, {
        isActive: true, isDraft: false, needsFirstRunConfirm: false,
    }, userId);
    await ensureAppEventSubscription(automationId, userId, def);
    // Additional schedule triggers need their automation_schedules rows too —
    // an installed Solution automation with a second schedule would otherwise
    // never fire on it.
    await require('./scheduleSync').syncSchedules(automationId, def, { rearm: true });
    return { automation, warnings: v.warnings || [] };
}

/** Tear down a provisioned automation: remove its subscriptions, then delete it. */
async function teardownAutomation(automationId) {
    if (!automationId) return false;
    try { await automationStore.deleteSubscriptionsForAutomation(automationId); } catch (_) { /* ignore */ }
    return automationStore.deleteAutomation(automationId).catch(() => false);
}

module.exports = { buildToolCatalog, ensureAppEventSubscription, activateAutomation, teardownAutomation };
