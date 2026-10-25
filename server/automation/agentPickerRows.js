// @typecheck
/**
 * The agent PICKER of the AI step: which agents are in the list, and what is shown beside one that cannot
 * be chosen? (R2, part C)
 *
 * ── WHY THIS IS NOT automation/agentCatalog.js ──────────────────────
 * That module answers the VALIDATION question: may this automation use this one id, yes or no. It
 * deliberately never says why not — an id comes out of a definition that someone may also have typed by
 * hand, and a broken-down answer ("does not exist" vs. "other organisation") would make the automation
 * editor an existence oracle for every other workspace on this installation.
 *
 * Here it is different, and that is precisely why it is a separate module. This list is not built from a
 * definition but from what the asker ALREADY MAY SEE: his own agents plus the published agents that his
 * organisation and his groups show him. About those rows he already knows everything. "This one is there
 * but is not yet published" therefore tells him nothing new — and leaving it out is the worst of all: then
 * someone searches for his agent, does not see it, and goes looking for a bug instead of pressing the
 * publish button.
 *
 * The boundary is therefore: the REASON travels only for a row that the caller has already made visible
 * himself. Never for an id that someone typed in.
 *
 * ── ONE JUDGEMENT, AND THE REASON DOES NOT DECIDE ───────────────────
 * `canUse` comes from `mayAutomationUseAgent` — the same function that the save check uses and that
 * `aiStepAgent._mayUseAgent` has beside it on every run. The reason below is EXPLANATION and not a second
 * judgement: it is only computed when the judgement is already "no", and so it cannot turn that "no" into a
 * "yes". Were `explainRefusal` to miss a case, the outcome would be a vaguer sentence ('unavailable') and
 * never an agent that becomes choosable after all.
 */

'use strict';

const { mayAutomationUseAgent, servesPublishedConfig } = require('./agentCatalog');

/**
 * The reasons that the picker shows. Only these four; a case that does not fit is `unavailable` — vaguer,
 * never broader.
 *
 *   not_published  the agent is still a draft — the publish switch off, or on without a VERSION ever having
 *                  been published (then it still runs on its live draft; `servesPublishedConfig`)
 *   other_org      it belongs to a different organisation than the asker
 *   not_shared     published, same organisation, but shared with groups that the asker is not in
 *   unavailable    the judgement was no and none of the three fits
 */
const AGENT_PICKER_REASONS = Object.freeze(['not_published', 'other_org', 'not_shared', 'unavailable']);

/** Agents that are not a choice: the product supplies them, nobody publishes them. */
const SYSTEM_OWNER_IDS = Object.freeze(['system', 'swarm']);

/**
 * @param {{ owner_id: string; }} agent
 */
function _isSystemAgent(agent) {
    return !!agent && SYSTEM_OWNER_IDS.includes(agent.owner_id);
}

/**
 * Why may this asker not use this agent?
 *
 * Called ONLY when `mayAutomationUseAgent` has already said no — see the heading. The order is that of
 * `mayAutomationUseAgent` itself, so that the sentence names the first hurdle and not a later one.
 */
function explainRefusal(agent, { userId: _userId = null, orgId = null, groups = [] } = {}) {
    if (!agent) return 'unavailable';
    // Both publication hurdles give the same sentence, because the action is the same: publishing. Switching on
    // the sharing switch without ever having published a version leaves the agent running on its LIVE draft,
    // and an automation of someone else may not build on that — see `servesPublishedConfig`.
    if (!agent.is_published || !servesPublishedConfig(agent)) return 'not_published';
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return 'other_org';
    } else if (agent.organization_id) {
        return 'other_org';
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    const mine = Array.isArray(groups) ? groups : [];
    if (sharedGroups.length > 0 && !sharedGroups.some((g) => mine.includes(g))) return 'not_shared';
    // The judgement was no and none of the three fits — then the honest sentence is the vague one. Never fall
    // back on "then it is surely allowed".
    return 'unavailable';
}

/**
 * The rows for the picker.
 *
 * @param {Array} rows   agent rows as `getAgents` and `getPublishedAgentsForUser` give them (parseConfig form:
 *   `shared_groups` is already an array). The caller glues the two lists together; here it is de-duplicated
 *   on id, where the FIRST wins — so the own-agents list should come first, because that carries the draft
 *   state of a row that appears in both lists.
 * @param {object} viewer  `{ userId, orgId, groups }` of the AUTOMATION OWNER
 * @returns {Array<{id,name,description,scope,canUse,reason}>} sorted by name
 */
function agentPickerRows(rows, viewer = {}) {
    const seen = new Set();
    const out = [];
    for (const agent of Array.isArray(rows) ? rows : []) {
        if (!agent || typeof agent !== 'object') continue;
        const id = typeof agent.id === 'string' ? agent.id : null;
        if (!id || seen.has(id)) continue;
        // System agents have no publish button and are not a choice; they would appear here as "not yet published",
        // and that is a guess that nobody can act on.
        if (_isSystemAgent(agent)) continue;
        seen.add(id);
        const canUse = mayAutomationUseAgent(agent, viewer) === true;
        out.push({
            id,
            name: typeof agent.name === 'string' && agent.name ? agent.name : id,
            description: typeof agent.description === 'string' ? agent.description : null,
            // Wie hem verder nog kan zien — dezelfde woorden als de
            // kennisbank-kiezer hierboven in dezelfde catalogus.
            scope: agent.organization_id ? 'org' : 'personal',
            canUse,
            reason: canUse ? null : explainRefusal(agent, viewer),
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

module.exports = { AGENT_PICKER_REASONS, agentPickerRows, explainRefusal };

/**
 * @typedef {import('./agentCatalog').AgentRuntimeRow & { id?: string, name?: unknown, description?: unknown }} PickerAgent
 * @typedef {{ userId?: string|null, orgId?: string|null, groups?: string[] }} PickerViewer
 * @typedef {{ id: string, name: string, description: string|null, scope: 'org'|'personal', canUse: boolean, reason: 'not_published'|'other_org'|'not_shared'|'unavailable'|null }} PickerRow
 */
