'use strict';
/**
 * Web research for the Automation Builder's own chat: agent_search and read_url,
 * offered to the builder model when the composer's Web search toggle is on.
 *
 * Why this exists: the toggle used to reach the prompt only as "you may PROPOSE
 * an agent_search step". The builder model itself had no search tool, so with
 * the toggle on it told the user to look up an app's API documentation
 * themselves. Now the toggle offers the same two read-only tools direct chat
 * has, behind the same gates:
 *   - the installation has a search provider (webSearchAvailability.js, the
 *     check getIntegrationTools runs for direct chat);
 *   - this user may use the web-search app (isIntegrationPermittedForUser: the
 *     per-user apps, the org and group entitlements);
 *   - the org's "no web search once files are attached" shield policy.
 * At run time a call passes the Web Search Guard (the org's PII categories for
 * search queries, as in directChat/toolExec.js), the Privacy Shield tool block
 * lists (the turn's toolLoopGate) and runs through the provider-aware search
 * with an egress row (agentSearchEgress.js).
 *
 * The tools only read the web; they never change the draft, so every work mode
 * allows them (workMode.js READ_TOOLS).
 */

const log = require('../../../telemetry/log');

const WEB_RESEARCH_TOOL_NAMES = new Set(['agent_search', 'read_url']);
// A search answer or a page can be ~60k characters; the builder prompt already
// carries the draft and the catalogue, so one result may not crowd them out.
const RESULT_MAX_CHARS = 24000;

// What the model is told when the tools are not offered, so it never claims a
// search it cannot run. Keys are the `reason` values the UI also receives.
const REASON_TEXT = {
    off: 'the user switched Web search off in the composer',
    not_configured: 'no web search provider is set up on this installation',
    not_permitted: 'web search is not enabled for this user or organisation',
    upload_policy: 'the organisation turns web search off in a conversation with attached files',
    unavailable: 'the web search check failed',
};

// Resolved lazily (the stores reach the database at require time). Tests
// replace entries here; the route itself never passes deps.
const _deps = {
    providerStatus: () => require('../../../integrations/webSearchAvailability').webSearchProviderStatus(),
    isPermitted: (o) => require('../../../core/integrations/integrationTools').isIntegrationPermittedForUser(o),
    // The RESOLVED shield, as direct chat reads it (guardrailsRunner): the
    // org's, or for a personal account the user's own, with the tier clamps
    // and defaults applied. The raw org config row missed personal shields.
    getShield: (ids) => require('../../../core/privacy/orgShield').resolveShieldFor(ids),
    tools: () => require('../../../integrations/agentSearchTools').AGENT_SEARCH_TOOLS,
    run: (name, args, egress) => require('../../../integrations/agentSearchEgress').runAgentSearchWithEgress(name, args, egress),
    detectPii: (...a) => require('../../../core/privacy/piiDetection').detectPii(...a),
    logGuardrailEvent: (row) => require('../../../stores/guardrailEventStore').logGuardrailEvent(row),
};

const hasFiles = (list) => Array.isArray(list) && list.length > 0;

/**
 * Decide, once per turn, whether the builder model gets the web tools.
 *
 * @returns {Promise<{ offered: boolean, reason: string|null, tools: object[], guard: { piiCategories: string[], block: boolean } }>}
 */
async function resolveWebResearch({ requested, userId, orgId = null, session = null, isAdmin = false, attachments = [], history = [] }, deps = _deps) {
    const none = (reason) => ({ offered: false, reason, tools: [], guard: { piiCategories: [], block: false } });
    if (!requested) return none('off');
    try {
        const status = await deps.providerStatus();
        if (!status?.available) return none('not_configured');
        if (!(await deps.isPermitted({ userId, appId: 'agent-search', session, isAdmin }))) return none('not_permitted');
        const shield = await deps.getShield({ orgId: orgId || null, userId });
        const on = !!shield?.enabled;
        if (on && shield.disableSearchOnUpload
            && (hasFiles(attachments) || (Array.isArray(history) && history.some(m => hasFiles(m?.attachments))))) {
            return none('upload_policy');
        }
        const piiCategories = on && Array.isArray(shield.webSearchGuardPiiCategories) ? shield.webSearchGuardPiiCategories : [];
        return { offered: true, reason: null, tools: deps.tools(), guard: { piiCategories, block: on && !!shield.webSearchGuardEnabled } };
    } catch (e) {
        // Fail closed: a check that cannot run offers nothing, and the model is
        // told so instead of being handed a tool that may not be allowed.
        log.warn('[AutomationBuilder] web research gate failed; tools not offered:', e.message);
        return none('unavailable');
    }
}

function isWebResearchTool(name) {
    return WEB_RESEARCH_TOOL_NAMES.has(name);
}

// What leaves Bee Flow: the query, or the URL plus the passage to find.
function outboundText(name, args) {
    if (name === 'agent_search') return typeof args?.query === 'string' ? args.query : '';
    return [args?.url, args?.find].filter(v => typeof v === 'string' && v).join(' ');
}

/**
 * Run one web tool call for the builder model.
 *
 * @param {string} name   agent_search | read_url
 * @param {object} args
 * @param {object} ctx
 * @param {object} ctx.research  resolveWebResearch's answer for this turn
 * @param {{ refuse: Function }} ctx.gate  the turn's Privacy Shield toolLoopGate
 * @param {{ userId: string, orgId: string|null, automationId: string|null, modelId: string|null }} ctx.ids
 * @returns {Promise<{ result: object, modelText: string|null }>}
 *   `result` is what the panel shows; `modelText` the text the model reads
 *   (null on a refusal, then the model reads `result`).
 */
async function runWebResearchTool(name, args, { research, gate, ids }, deps = _deps) {
    const refuse = (error) => ({ result: { error }, modelText: null });
    if (!research?.offered || !isWebResearchTool(name)) return refuse('Web search is not available in this chat.');
    const text = outboundText(name, args);
    if (!text.trim()) return refuse(name === 'agent_search' ? 'query is required' : 'url is required');

    const cats = research.guard?.piiCategories || [];
    if (cats.length) {
        try {
            const scan = await deps.detectPii(text, cats);
            if (scan?.hasPii) {
                const found = [...new Set((scan.entities || []).map(e => e.label))].join(', ');
                const block = !!research.guard.block;
                deps.logGuardrailEvent({
                    organization_id: ids.orgId || null, user_id: ids.userId, automation_id: ids.automationId || null,
                    violation_type: 'pii', violation_categories: found, direction: 'input',
                    action_taken: block ? 'search_blocked' : 'pii_detected', source: 'automation_builder', model: ids.modelId || null,
                })?.catch?.(() => {});
                if (block) return refuse(`Web search blocked: the query contains sensitive personal information (${found}). Rephrase it without personal data.`);
            }
        } catch (e) {
            // Fail open, as direct chat's Web Search Guard does: the guard is
            // monitoring first, and the shield's block lists below still apply.
            log.warn('[AutomationBuilder WebSearchGuard] PII check failed (fail-open):', e.message);
        }
    }

    const refusal = gate ? await gate.refuse(name, args) : null;
    if (refusal) return refuse(refusal.modelError);

    let value;
    try {
        value = await deps.run(name, args, {
            source: 'automation_builder',
            ids: { organization_id: ids.orgId || null, user_id: ids.userId || null, automation_id: ids.automationId || null },
        });
    } catch (e) {
        return refuse(`Web search failed: ${e.message}`);
    }
    if (value && typeof value === 'object' && value.error) return refuse(String(value.error));
    let out = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (out.length > RESULT_MAX_CHARS) out = `${out.slice(0, RESULT_MAX_CHARS)}\n…[cut at ${RESULT_MAX_CHARS} characters]`;
    return { result: { ok: true, text: out }, modelText: out };
}

/** The per-turn prompt line about web research (renderTurnPreferences). */
function webResearchPromptLine(research) {
    if (!research) return null;
    if (research.offered) {
        return '- Web research: ON. You have `agent_search` (find pages) and `read_url` (read one page by URL). When you need facts you do not have, such as an app\'s API documentation, endpoints, authentication or field names, look them up yourself with these tools instead of asking the user to search, and name the URLs you used. They only read the web; they never change the automation.';
    }
    const why = REASON_TEXT[research.reason] || REASON_TEXT.unavailable;
    return `- Web research: OFF in this chat (${why}). You cannot search or open web pages now; never claim you did. If the user asks you to look something up online, say so plainly and ask them to paste the link or the relevant text${research.reason === 'off' ? ', or to switch Web search on in the composer\'s + menu' : ''}.`;
}

module.exports = { _deps, resolveWebResearch, runWebResearchTool, isWebResearchTool, webResearchPromptLine, WEB_RESEARCH_TOOL_NAMES, RESULT_MAX_CHARS };
