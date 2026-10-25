// @typecheck
'use strict';

/**
 * On what an agent may base its answer — ONE rule, three readers.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────
 *
 * The rule already existed: routes/studio/attentionChecks.js `evaluateAgentNoKb`
 * turns it into the "Needs attention" notice on the Studio start screen (H3). The footer
 * of the agent overview (A5) must be able to say exactly the same sentence — "Answers from
 * memory — connect a knowledge base" — and that must not become a second implementation.
 * Two implementations of one rule drift apart, and the first screen where that shows is
 * precisely the screen where someone sees them side by side: Start says "needs attention"
 * and the overview says nothing about the same agent.
 *
 * So the criterion lives here, without dependencies, and `routes/studio/attentionChecks.js`
 * (the attention point), `routes/agents/published.js` (the field `grounding` on every row of
 * GET /agents/all) AND `./personaPrompt.js` (the knowledge gate of `applyPersonaToConfig`)
 * all read it from here. Pure, so that each side can test it with plain objects.
 *
 * ── THREE VALUES PER AXIS, AND THE THIRD IS THE REASON ───────────────────
 *
 *   true   this source is connected
 *   false  checked, and there is none
 *   null   NOT READABLE — the key is there, but in a shape from which nothing can be
 *          derived (a string where a list belongs)
 *
 * `null` is explicitly not `false`. "This agent has no knowledge base" is a CLAIM with an
 * obligation attached; "I could not read its wiring" is not. The attention list makes
 * the second a named gap (`agents:config`) and the footer stays silent about it — both
 * narrow, neither fills in a zero.
 *
 * ── TWO AXES, AND WHY WEBSEARCH IS NOT ONE ──────────────────────────────
 *
 * Until A5 this rule looked only at `knowledge_base_ids`. An agent with only a table grant
 * was therefore reported as "answers from the model alone", and that is untrue:
 * `core/tools/datatableTools.js` really gives it something to look at. Hence the second axis.
 *
 * A THIRD axis on `config.enabledIntegrations` (websearch) was here for a while, and is out
 * again because it measures nothing. Checked in the source:
 *
 *   - `core/agentRuntime/toolStackAssembly.js` passes the agent config to `getIntegrationTools`,
 *     but there only `config.tools` is read (the automation curation). Which apps an agent gets
 *     hangs on `enabled_apps_user_<id>` — the USER — plus `AUTO_ENABLED_APPS`, where
 *     `agent-search` is listed, plus whether a search provider is configured at all
 *     (`searchAvailable`). Outside aiTaskRunner (automation OAuth), automationAuth and the
 *     packaging, nobody in server/ reads the field `config.enabledIntegrations`.
 *   - `stores/agent/initSchema.js` (R4 backfill) set `agent-search` on EVERY agent row from
 *     before that migration. If "web on" counted as grounding, practically every existing agent
 *     would be grounded without anything having changed for it.
 *
 * Both sides then fail: on a self-host without a search profile the axis would call an agent
 * "grounded" that demonstrably answers from the model alone, and on a deployment WITH a search
 * provider practically every agent has websearch while the axis says `false`. An axis that lies
 * in both directions is not an axis.
 *
 * ── THE CONFIG IS THE TRUTH, AND ALSO THE SPELLING THAT THE RUNTIME READS ──
 *
 * `applyPersonaToConfig` (./personaPrompt.js) can promise web without the runtime offering it;
 * what the runtime offers is in the config. For the knowledge bases that also means: only
 * `config.knowledge_base_ids`. `core/agentRuntime/knowledgeSearch.js` does
 * `agent.config?.knowledge_base_ids || []` and has NO camelCase branch, so a row that carries
 * only `knowledgeBaseIds` yields zero searched knowledge bases there. Counting it as a source
 * would call an agent "grounded" that searches nothing on every turn.
 */

/**
 * Keys that are never a table grant. Mirror of `UNSAFE_OBJECT_KEYS` in
 * agent-hub/…/canUse/canUseFacts.js: `JSON.parse('{"__proto__":{}}')` yields an own key, and
 * without this sieve such a config would read as "grounded on a table" while the runtime
 * does nothing with it.
 */
const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * An axis that comes from a LIST.
 *
 * Absent (`undefined`/`null`) ⇒ `false`: a config without that key really does not have that
 * source. Present but not a list ⇒ `null`: something is there, we just do not know what.
 */
function listAxis(raw, matches) {
    if (raw === undefined || raw === null) return false;
    if (!Array.isArray(raw)) return null;
    return raw.some(matches);
}

/**
 * De tabel-as: `config.tools.datatables`, met dezelfde vormcontrole die
 * toolPolicy.js's `_datatableGrants` doet (`_plainObject`, anders niets).
 * Twee niveaus, en op allebei geldt: er staat iets onleesbaars ⇒ `null`.
 */
function tablesAxis(config) {
    const tools = config.tools;
    if (tools === undefined || tools === null) return false;
    if (!isPlainObject(tools)) return null;
    const grants = tools.datatables;
    if (grants === undefined || grants === null) return false;
    if (!isPlainObject(grants)) return null;
    return Object.keys(grants).some(id => !UNSAFE_OBJECT_KEYS.has(id));
}

/**
 * What this agent config is grounded on, per source.
 *
 * @param {object|null|undefined} config the PARSED config column
 * @returns {{kb: boolean|null, tables: boolean|null}}
 *   A config that is not itself an object yields `null` twice — that is "unreadable", and the
 *   caller should report that as a gap, not as an agent without sources.
 */
function groundedOn(/** @type {any} */ config) {
    if (!isPlainObject(config)) return { kb: null, tables: null };
    return {
        // Snake_case only: that is the key that knowledgeSearch.js reads.
        // See the header — a camelCase list is never searched, so it is not a source.
        // An empty string or only spaces does not count either: that yields nothing from
        // `getKnowledgeBase`.
        kb: listAxis(config.knowledge_base_ids, v => typeof v === 'string' && v.trim() !== ''),
        tables: tablesAxis(config),
    };
}

/**
 * The verdict on the axes, as one word.
 *
 *   'grounded'    at least one source is confirmed
 *   'ungrounded'  all axes were read and all are empty
 *   null          at least one axis was not readable ⇒ no verdict
 *
 * The order matters: one hard `true` makes the agent grounded, even if another axis was
 * unreadable — that one can only add yet another source. Conversely, one unreadable axis
 * must never lead to "grounded on nothing".
 *
 * @param {{kb: boolean|null, tables: boolean|null}} axes
 * @returns {'grounded'|'ungrounded'|null}
 */
function groundingVerdict(axes) {
    const values = [axes?.kb, axes?.tables];
    if (values.some(v => v === true)) return 'grounded';
    if (values.every(v => v === false)) return 'ungrounded';
    return null;
}

/** `groundedOn` + `groundingVerdict` in de vorm die over de API reist. */
function groundingOf(config) {
    const axes = groundedOn(config);
    return { ...axes, verdict: groundingVerdict(axes) };
}

/**
 * Does this config name a KNOWLEDGE BASE — something that "answer only from your
 * knowledge" can be about?
 *
 * THE KB AXIS ALONE, and that is deliberately narrower than `groundingVerdict`. The flag that
 * hangs on this is `strictKnowledge`, and `contextBuilder.js` turns it into a CRITICAL
 * OPERATIONAL CONSTRAINT that overrules every other instruction as soon as there is no
 * "KNOWLEDGE BASE RESULTS" section. That section is built by `knowledgeSearch.js` exclusively
 * from `config.knowledge_base_ids`: a table grant yields none of it, however real that source
 * is otherwise. If a table agent counted here, the honesty setting would set it to refuse —
 * also for questions about the table it has just been given.
 *
 * `null` (unreadable) counts here as ABSENT, and that is the honest reading for this one
 * question: a config that we could not read must never be the thing that silently sets an
 * agent to refuse.
 */
function hasKnowledgeSource(config) {
    return groundedOn(config).kb === true;
}

module.exports = {
    groundedOn,
    groundingVerdict,
    groundingOf,
    hasKnowledgeSource,
};

/**
 * @typedef {{ knowledge_base_ids?: unknown, tools?: unknown } | null | undefined} GroundingConfig
 */
