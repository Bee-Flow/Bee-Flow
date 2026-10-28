/**
 * "This automation calls an agent — may that run here?" — the SAVE side of R2.
 *
 * ── WHY THIS IS NOT IN validate/stepRules.js ────────────────────────
 * The rule IS there; the ANSWER cannot come from there. Whether the agent exists, sits in the same
 * organisation, and is published: those are three database questions, and `validate/` is deliberately
 * the pure pass (it runs in the builder, at import, and in tests without a database behind it). So
 * this module supplies the catalogue — a Set with the ids that this automation MAY use — and the
 * route passes that on as `availableAgents`. Precisely the construction that `availableTools` already
 * uses, and the same split as `core/kb/automationKbCheck.js` for knowledge bases.
 *
 * ── ONE ANSWER FOR EVERY WAY OF NOT BEING ALLOWED ───────────────────
 * This module says only WHICH ids are allowed. Not which exist, not why an id is missing. That is not
 * laziness but the point: a deleted agent, an agent of another organisation, an agent that is not
 * shared with the owner and an agent that was never published all fall out of the Set in the same way,
 * and `stepRules.js` makes one message of it. Were the distinction to survive here or there, the
 * automation editor would become an existence oracle for every other workspace on this installation:
 * type an id, and read from the error message whether it exists somewhere.
 *
 * ── THE SAME QUESTION AS THE RUN, BUT A DAY EARLIER ─────────────────
 * `mayAutomationUseAgent` below asks exactly the question that `core/automationRunner/aiStepAgent.js`
 * (`_mayUseAgent`) asks on EVERY run. That those two stay equal is not self-evident, so it is a test
 * (automation/validate.agentStep.test.js) and not a promise: the test runs both over the same table of
 * cases and compares the outcome.
 *
 * The run is the real gate. This pass runs at save and at activation; the agent may be deleted,
 * unpublished or withdrawn from sharing days later, and no validation sees that coming.
 * `resolveStepAgent` THROWS then, so that the step fails instead of running on without an agent. That is
 * why this pass may be fail-open — and why only as a whole: an id that we could not check is never
 * reported as "not allowed" (that would be a wrong answer to a failure), and never quietly approved
 * either. Then there is simply no catalogue.
 */
const log = require('../../telemetry/log');
// Does this row run on its PUBLISHED config? Pure, so it lives below the
// features: core/automationModel/agentPublication.js (the whole argument is there).
const { servesPublishedConfig } = require('./agentPublication');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Walk the steps, including loop bodies and parallel branches — the same nesting that `validate/`,
 * `portability.js` and `automationKbCheck.js` walk. Rewritten rather than imported, for the reason that
 * `automationKbCheck.js` gives about itself: this must be requirable from a route without dragging the
 * whole automation feature along.
 */
function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

/**
 * Every agent id that this definition names — in the main graph and in every inline layer. Only the ids;
 * which step names them is already known to `stepRules.js`.
 */
function collectAgentIds(definition) {
    const ids = new Set();
    const take = (/** @type {{ type: string; agentId: string; }} */ step) => {
        if (step.type !== 'ai_step') return;
        const id = typeof step.agentId === 'string' ? step.agentId.trim() : '';
        if (id) ids.add(id);
    };
    walkSteps(definition?.steps, take);
    const layers = isObject(definition?.layers) ? definition.layers : {};
    for (const layer of Object.values(layers)) {
        if (isObject(layer)) walkSteps(layer.steps, take);
    }
    return [...ids];
}

/**
 * May this automation deploy this agent?
 *
 * The four rules, in the order in which they decide:
 *
 *   owner                   → yes, also unpublished. Your own agent in your own automation is not a sub-question.
 *   not published           → no. Publishing is what turns an agent from a draft into something another person
 *                             can build on — and that holds for the VERSION just as much as for the sharing
 *                             switch (`servesPublishedConfig`).
 *   other organisation      → no, and an org agent towards someone without an organisation just as little.
 *   shared with groups      → only if the owner is in one of those groups.
 *
 * A group list that could not be read is empty, and empty means here "in no group at all": unknown
 * narrows, here too.
 *
 * `owner_id` equality alone would be too strict (an automation may use a shared org agent) and
 * `organization_id` equality alone too broad (a colleague's unshared agent does not belong in someone
 * else's automation).
 *
 * @param {AgentRuntimeRow | null | undefined} agent   a row as `agentStore.getForRuntime` gives it
 * @param {{ userId?: string|null, orgId?: string|null, groups?: string[] }} [p]  of the AUTOMATION OWNER
 */

function mayAutomationUseAgent(agent, { userId = null, orgId = null, groups = [] } = {}) {
    if (!agent) return false;
    if (agent.owner_id && userId && agent.owner_id === userId) return true;
    if (!agent.is_published) return false;
    // Shared is not yet published — see `servesPublishedConfig`.
    if (!servesPublishedConfig(agent)) return false;
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return false;
    } else if (agent.organization_id) {
        return false;
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    if (sharedGroups.length === 0) return true;
    const mine = Array.isArray(groups) ? groups : [];
    return sharedGroups.some((g) => mine.includes(g));
}

/**
 * The catalogue for one definition: the agent ids that this automation may use.
 *
 * Only the ids that the definition NAMES are looked up — not the whole library. An automation names at
 * most a handful, and the question "which other agents exist" need not be answered anywhere to answer
 * this one.
 *
 * @returns {Promise<Set<string>|null>} `null` = not checkable (no catalogue, so no rule; the run checks
 *   again). Never a half Set: one failed lookup switches the whole pass off.
 */
async function agentCatalogFor(definition, { userId = null, orgId = null, groups = [], deps = {} } = {}) {
    const ids = collectAgentIds(definition);
    // No agent step ⇒ an empty catalogue, not `null`: there is nothing to check, and `null` would mean
    // "the check could not run".
    if (!ids.length) return new Set();
    try {
        const store = deps.agentStore || require('../../stores/agentStore');
        const usable = new Set();
        for (const id of ids) {
            const agent = await store.getForRuntime(id);
            if (mayAutomationUseAgent(agent, { userId, orgId, groups })) usable.add(id);
        }
        return usable;
    } catch (e) {
        // See the heading: a failure must not become a refusal. Without a catalogue `stepRules.js` skips the
        // identity rule and the run check remains the gate.
        log.warn('[automation/agentCatalog] agent lookup unavailable — saving without the agent check:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * The catalogue for one definition, with the IDENTITY that the run uses.
 *
 * ── WHY THIS STANDS BESIDE agentCatalogFor ──────────────────────────
 * `agentCatalogFor` is given `{userId, orgId, groups}`, and that is precisely the part that each caller
 * did differently: the activation route took the STAMP on the automation row (`a.organizationId`) with
 * the session as fallback, the run reads the MEMBERSHIP of the owner fresh from `users`
 * (`ctx.userHomeOrgId`, execution.js), and the picker something else again. Three answers to one question
 * means that one of the three approves an automation that the run refuses — green on screen,
 * `agent_unavailable` every night.
 *
 * So the question is asked here once, and all save and activation paths ask it in this way: the OWNER of
 * the automation, his current organisation, his current groups. An administrator who moves someone to
 * another organisation thereby changes what that person's automations may do — that is the answer that is
 * right, because it is also what the run does.
 *
 * Fail-open as a WHOLE, just like `agentCatalogFor`: an identity read that fails yields `null` (no catalogue,
 * so no rule), never a half Set in which an agent is wrongly reported as "not allowed".
 *
 * @param {object} definition  the automation definition
 * @param {string} ownerId     the OWNER of the automation (not the person pressing the button)
 * @returns {Promise<Set<string>|null>}
 */
async function agentCatalogForOwner(definition, ownerId, { deps = {} } = {}) {
    // No agent step ⇒ no lookup at all. An empty Set, not `null`: there is nothing to check, and `null` would
    // mean "the check could not run".
    if (!collectAgentIds(definition).length) return new Set();
    if (!ownerId) return null;
    let orgId = null;
    let groups = [];
    try {
        const userStore = deps.userStore || require('../../stores/userStore');
        const { resolveUserGroups } = deps.audience || require('../../auth/audience');
        const [owner, gs] = await Promise.all([userStore.getUser(ownerId), resolveUserGroups(ownerId)]);
        orgId = (owner && owner.organizationId) || null;
        groups = Array.isArray(gs) ? gs : [];
    } catch (e) {
        log.warn('[automation/agentCatalog] owner identity unavailable — saving without the agent check:', /** @type {Error} */ (e).message);
        return null;
    }
    return agentCatalogFor(definition, { userId: ownerId, orgId, groups, deps });
}

module.exports = { collectAgentIds, mayAutomationUseAgent, agentCatalogFor, agentCatalogForOwner, servesPublishedConfig };

/**
 * injectable collaborators (tests pass fakes).
 * @typedef {{ agentStore?: typeof import('../../stores/agentStore'),
 *   userStore?: typeof import('../../stores/userStore'), audience?: typeof import('../../auth/audience') }} CatalogDeps
 */

/**
 * `shared_groups`: a parsed list, or the raw JSON text of one that was not parsed.
 * @typedef {{ owner_id?: string, is_published?: boolean, organization_id?: string|null,
 *   runtimeSource?: string, published_version?: unknown, shared_groups?: string[]|string|null }} AgentRuntimeRow
 */
