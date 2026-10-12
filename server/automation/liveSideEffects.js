/**
 * The helpers an automation's save, activation and publish share — moved out of
 * routes/automation/crud.js so that code below routes/ (the go-live cores in
 * automation/goLive.js, and the Solution deploy engine that calls them) can use
 * the SAME functions the routes do. An automation must never be able to resolve an
 * agent catalog, a knowledge-base finding or an organisation differently
 * depending on which path asked.
 *
 * Every function here is best-effort or fail-open, exactly as it was in the
 * route file: none of them may turn a successful save or activation into an
 * error.
 *
 * `makeLiveSideEffects(deps)` builds the same set over injected modules (tests,
 * no module mocking). The module exports the default set, whose dependencies
 * are required LAZILY, at call time — so a test that swaps a module through
 * require.cache before loading the router still reaches these functions.
 */

'use strict';

const log = require('../telemetry/log');

/**
 * @param {object} [deps]
 * @param {object} [deps.automationStore]   ensureFormPage
 * @param {object} [deps.userStore]         getUser
 * @param {object} [deps.subjectReview]     reviewAutomation
 * @param {object} [deps.formAnswers]       ensureAnswersTable
 * @param {Function} [deps.agentCatalogForOwner]
 * @param {Function} [deps.kbStepFindings]
 */
function makeLiveSideEffects(deps = {}) {
    const automationStore = () => deps.automationStore || require('../stores/automationStore');
    const userStore = () => deps.userStore || require('../stores/userStore');
    const subjectReview = () => deps.subjectReview || require('../compliance/subjectReview');
    const formAnswers = () => deps.formAnswers || require('./formAnswers');
    const agentCatalogForOwner = () => deps.agentCatalogForOwner || require('./agentCatalog').agentCatalogForOwner;
    const kbStepFindings = () => deps.kbStepFindings || require('../core/kb/automationKbCheck').kbStepFindings;

    /**
     * R2 — the agent ids this automation's OWNER may hand an ai_step to, or `null`
     * when the question could not be asked (the rule is then skipped; the run
     * is the gate). One helper for every path, so save and activate can never
     * resolve the identity differently — see automation/agentCatalog.js.
     */
    async function agentsFor(definition, ownerId) {
        try {
            return await agentCatalogForOwner()(definition, ownerId);
        } catch (e) {
            log.warn('[automation] agent catalog build failed; continuing without the agent check:', e.message);
            return null;
        }
    }

    /**
     * Knowledge-base findings for a definition, at a stage.
     *
     * `orgId` is the organisation the check scopes by: a value, or a function
     * answering it (the route passes its own `orgOf(req)` that way, so a
     * failure resolving it stays inside this function's fail-open).
     *
     * Fail-OPEN on its own errors: a knowledge-base store that is down must not
     * make every automation unsaveable, and the runtime re-checks each id before
     * it searches anyway. A finding this pass cannot produce is a missing
     * warning, not a missing gate.
     */
    async function kbFindingsFor(definition, { orgId = null, userId, stage } = {}) {
        try {
            const resolvedOrg = typeof orgId === 'function' ? await orgId() : orgId;
            return await kbStepFindings()(definition, { orgId: resolvedOrg, userId, stage });
        } catch (e) {
            log.warn('[automation/crud] knowledge-base check unavailable:', e.message);
            return [];
        }
    }

    /**
     * Tell compliance that this automation's posture just changed.
     *
     * The Compliance Center used to learn about an automation only from the
     * 6-hourly sweep in compliance/scheduler.js. Switch an automation on at 09:05
     * and the sweep that had already run at 06:00 was the last word until
     * 12:00. Activation is the moment that stops being a build-time detail, so
     * activation is where the review is asked for.
     *
     * FIRE-AND-FORGET, DELIBERATELY. This returns before anything compliance-
     * shaped has happened: the org lookup, the queueing and the checks all run
     * after the response, and nothing in here may turn a successful activation
     * into an error. Worst case the verdict waits for the scheduled sweep.
     *
     * The queue itself (compliance/subjectReview.js) coalesces and scopes: five
     * flips of one switch are one review of one automation.
     *
     * `organizationId` first, then the OWNER's — the COALESCE the checks scope
     * their own subject lists by (compliance/aiAct/signals.js). Never the
     * presser's org.
     *
     * Started on the NEXT turn of the event loop rather than in a microtask:
     * the routes reach this through an awaited core (automation/goLive.js),
     * and a microtask queued here would run before the route's own
     * continuation has written the response.
     */
    function wakeComplianceReview(a, reason) {
        setImmediate(() => wakeNow(a, reason));
    }

    function wakeNow(a, reason) {
        Promise.resolve().then(async () => {
            // "First, then" literally: a stamped row already answers the
            // question, so the owner is only read when it does not.
            let orgId = a.organizationId || null;
            if (!orgId && a.userId) {
                const owner = await userStore().getUser(a.userId).catch(() => null);
                orgId = owner?.organizationId || null;
            }
            // No organisation: no per-source check can match this automation (their
            // subject queries are org-scoped) — a personal install, not an error.
            if (!orgId) return;
            subjectReview().reviewAutomation(orgId, a.id, { reason });
        }).catch(e => log.warn(`[automation/${reason}] compliance review could not be queued for ${a.id}: ${e.message}`));
    }

    /**
     * Make sure every `form` trigger in a definition has its public page.
     *
     * The page belongs to the trigger, not to whoever opened the builder panel
     * that used to mint it. The primary trigger is stored with a NULL
     * triggerStepId — the convention loadForm reads. Best-effort: a save must
     * not fail because a link could not be minted.
     */
    async function ensureFormPages(automationId, definition) {
        const primary = definition?.trigger;
        const extra = Array.isArray(definition?.triggers) ? definition.triggers : [];
        const wanted = [
            ...(primary?.kind === 'form' ? [null] : []),
            ...extra.filter(t => t?.kind === 'form' && t.id).map(t => t.id),
        ];
        for (const triggerStepId of wanted) {
            try {
                await automationStore().ensureFormPage(automationId, triggerStepId);
            } catch (e) {
                log.warn(`[automation form page] could not provision for ${automationId}: ${e.message}`);
            }
        }
    }

    /**
     * The answers table a form trigger writes into, kept in step with the form
     * (automation/formAnswers). Best-effort like ensureFormPages: the outcome
     * rides back as `answers`, a failure never fails the save. Returns the
     * usage entry the dependents index needs, so the table's "used by" names
     * the automation and a DELETE of the table warns.
     */
    async function ensureAnswersTable(automation, definition) {
        try {
            const out = await formAnswers().ensureAnswersTable(automation, definition);
            if (!out) return { answers: null, usage: [] };
            if (!out.table) return { answers: { datatableId: null, created: false, changed: false, error: out.error || null }, usage: [] };
            return {
                answers: {
                    datatableId: out.table.id, created: !!out.created, changed: !!out.changed,
                    ...(out.warnings && out.warnings.length ? { warnings: out.warnings } : {}),
                },
                usage: [{ datatableId: out.table.id, stepId: 'trigger:form', mode: 'write', columns: [] }],
            };
        } catch (e) {
            log.warn(`[form answers] ${automation?.id}: ${e.message}`);
            return { answers: { datatableId: null, created: false, changed: false, error: { code: 'provision_failed', message: e.message } }, usage: [] };
        }
    }

    return { agentsFor, kbFindingsFor, wakeComplianceReview, ensureFormPages, ensureAnswersTable };
}

module.exports = { makeLiveSideEffects, ...makeLiveSideEffects() };
