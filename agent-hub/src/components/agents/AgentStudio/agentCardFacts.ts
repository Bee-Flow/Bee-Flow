/**
 * agentCardFacts — the FACTS behind one card in the agent overview, and behind the chips and the search field above it (Bee Flow Builder redesign, Sept 2026; Agents artboard 1a, A5 part C).
 *
 * Everything here is pure: what goes in are the rows of `GET /agents/all` (or `/agents/system`) plus the category list, and what comes out are numbers and states — no sentences, no colours. The sentences are in `AgentCard.jsx` and `AgentOverview.tsx`, because that is where the literal `t()` keys are that the i18n guard reads.
 *
 * ── THE THREE PILLS COME FROM `config`, AND THAT IS ALLOWED ─────────
 * `getAllAgents` (server/stores/agent/agentCrud.js) runs every row through `parseConfig`, so `config` is in the list as a PARSED OBJECT — no extra server round trip is needed for "n knowledge / n skills / n tools". Two things that come with that, and that the card may not conceal:
 *
 *   1. It is the DRAFT config. For an agent with `published_version > 0` the runtime serves `published_config`, and that blob never leaves the store (`_stripPublishedBlobs`). The pills therefore count what is in the editor, not what runs live — exactly as the heading "v8" next to the status pill names the saved version.
 *   2. The tools pill counts what the CONFIG grants, not what THIS user has in his catalogue. The editor measures apps against `filterAvailableIntegrations` and deliberately shows nothing as long as `integrationStatus === null` (BuilderSplit.jsx). That availability is not in the list response, and inventing it here would suggest a measured figure. What the card does know is a fact about the AGENT: how many apps, automations and tables are granted to him.
 *   3. …and for most agents that number is a LOWER BOUND, not a total. `core/integrations/integrationTools.js` curates the automations only when `config.tools` CARRIES the key `automations`; if it is missing, the agent gets EVERY agent-callable automation of whoever is talking, plus every Step published in the chat. Counting zero automations for such an agent is the opposite of the truth, and it is precisely the trap that `canUse/toolGrants.js` documents by name. Hence `toolsAtLeast`: the number remains what the config NAMES, and the card says that more can be added.
 *
 * ── EMPTY IS NOT UNREADABLE ─────────────────────────────────────────
 * `config` can be missing or unreadable (a row from another source, a column that did not parse). Then the answer is `null` — not 0. A 0 is the claim "this agent has no knowledge", and that puts the card on screen as a dotted warning row; that may never rest on a reading that did not succeed.
 *
 * ── UNKNOWN NARROWS ─────────────────────────────────────────────────
 * `can_edit` is the server side of BFSF-271 and `/agents/all` always sets it. `/agents/system` does NOT do that. `can_edit === false` as the only test is therefore fail-open: a row without the field kept the bin. Here there are three states, and only an explicit `true` gives an edit affordance.
 */

import { datatableGrantsOf } from '../AgentWizard/canUse/canUseFacts';
import { automationGrantsOf } from '../AgentWizard/canUse/toolGrants';

/** May this user change the agent? `UNKNOWN` is neither `NO` nor `YES`. */
export const EDIT = Object.freeze({ YES: 'yes', NO: 'no', UNKNOWN: 'unknown' });

/** The category of a row: none, a name that was read, or an id without a name. */
export const CATEGORY = Object.freeze({ NONE: 'none', NAMED: 'named', UNKNOWN: 'unknown' });

/** De chip-id van "Zonder categorie" — geen echt categorie-id, dus geen botsing. */
export const NO_CATEGORY = '__no_category__';

/** The config blob of an agent row. */
export type AgentRowConfig = Record<string, unknown>;

/** One row of `GET /agents/all` (or `/agents/system`); every field may be missing. */
export interface AgentListRow {
    id?: string | null;
    name?: string;
    description?: string;
    config?: AgentRowConfig | string | null;
    can_edit?: boolean;
    category_id?: string | null;
    published_version?: number | string | null;
    is_published?: boolean | number;
    shared_groups?: string[] | string | null;
    avatar?: string | null;
}

/** A category as the list reads it. */
export interface CategoryLike { id?: string; name?: string }

/** The three counters of one card. */
export interface CardCounts {
    readable: boolean;
    knowledge: number | null;
    skills: number | null;
    tools: number | null;
    toolsAtLeast: boolean;
}

/** The category of a row: none, a name that was read, or an id without a name. */
export type CategoryVerdict =
    | { state: 'none'; id: null; name: null }
    | { state: 'named'; id: string; name: string }
    | { state: 'unknown'; id: string; name: null };

/** One filter chip above the grid. */
export interface CategoryChip { id: string | undefined; name: string | null | undefined; count: number | undefined }

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The config of a list row, or `null` if it is not readable in there.
 *
 * The server delivers an object (parseConfig). A string is still tried — a row that arrived by another route — but anything after that which is not a plain object is UNREADABLE and comes back as `null`.
 */
export function configOf(agent?: AgentListRow | null): AgentRowConfig | null {
    if (!agent) return null;
    const raw = agent.config;
    if (isPlainObject(raw)) return raw;
    if (typeof raw === 'string' && raw) {
        try {
            const parsed = JSON.parse(raw);
            return isPlainObject(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }
    return null;
}

/** Unique, non-empty strings from a list. No list ⇒ empty. */
function uniqueStrings(list: unknown) {
    const seen = new Set<string>();
    for (const v of Array.isArray(list) ? list : []) {
        if (typeof v === 'string' && v) seen.add(v);
    }
    return seen;
}

/**
 * The linked knowledge-base ids. Both spellings count: the config carries `knowledge_base_ids`, but `attentionChecks.js` has for years also accepted `knowledgeBaseIds`, and there are rows with that key in the field.
 */
function knowledgeIdsOf(config: AgentRowConfig) {
    const raw = config.knowledge_base_ids ?? config.knowledgeBaseIds;
    return uniqueStrings(raw);
}

/**
 * The three counters of one card.
 *
 * @returns
 *   `readable: false` ⇒ all three `null`: the config could not be read, and then the card says THAT, instead of showing three zeros.
 *   `tools: null` with a readable config means the same thing one level lower: the `config.tools` section IS there but is not readable, and then there is no number to show. `toolsAtLeast` says that the number is a LOWER BOUND.
 */
export function countsOf(agent?: AgentListRow | null): CardCounts {
    const config = configOf(agent);
    if (!config) return { readable: false, knowledge: null, skills: null, tools: null, toolsAtLeast: false };

    // "Section absent", "section readable" and "section unreadable" are three answers. The header of this file says "empty is not unreadable", and so far that held only for the WHOLE config: a `config.tools` that is not an object silently became a measured zero, while the server gives `tables: null` on the same input (core/agentRuntime/agentGrounding.js).
    const rawTools = config.tools;
    const toolsMissing = rawTools === undefined || rawTools === null;
    const toolsConfig = isPlainObject(rawTools) ? rawTools : null;
    const toolsUnreadable = !toolsMissing && !toolsConfig;

    // The apps are stored as a flat list in `enabledIntegrations`; the automations and tables as grants under `config.tools`. All three are "a thing this agent may call", so all three count in the same pill — the same sum that the "Can use" tab puts on its counter.
    const apps = uniqueStrings(config.enabledIntegrations).size;
    const automations = automationGrantsOf(toolsConfig).length;
    const datatables = datatableGrantsOf(toolsConfig).grants.length;

    // The PRESENCE of the key is the curation — mirror of `_curatedAutomations` in core/integrations/integrationTools.js, which checks `hasOwnProperty('automations')` and not the content. If it is missing, the automations of the ASKER ride along and this number is a lower bound.
    const curatedAutomations = !!toolsConfig
        && Object.prototype.hasOwnProperty.call(toolsConfig, 'automations');

    return {
        readable: true,
        knowledge: knowledgeIdsOf(config).size,
        skills: uniqueStrings(config.attachedSkillIds).size,
        tools: toolsUnreadable ? null : apps + automations + datatables,
        toolsAtLeast: !toolsUnreadable && !curatedAutomations,
    };
}

/**
 * LIVE or DRAFT is NOT in this file: `publishedVersionOf` in `AgentWizard/builderSplit/AgentEditorHeader.jsx` already answers that question (and its test pins that it reads `published_version` and not `is_published` — the CONTENT question, not the AUDIENCE). The card reads it there; a second copy here would let the two drift apart.
 */

/**
 * May this user edit the agent? Only an explicit boolean counts; a missing field is UNKNOWN — see the docblock at the top.
 */
export function editVerdict(agent?: AgentListRow | null) {
    const v = agent?.can_edit;
    if (v === true) return EDIT.YES;
    if (v === false) return EDIT.NO;
    return EDIT.UNKNOWN;
}

/**
 * The category of a row, against the read category list.
 *
 * A `category_id` that we cannot place becomes `UNKNOWN`, NEVER `NONE`: "no category" is a claim about the agent, and the agent does have one — we just could not read its name.
 */
export function categoryOf(agent: AgentListRow | null | undefined, categories?: readonly CategoryLike[] | null): CategoryVerdict {
    const id = typeof agent?.category_id === 'string' && agent.category_id ? agent.category_id : null;
    if (!id) return { state: CATEGORY.NONE, id: null, name: null };
    const hit = (Array.isArray(categories) ? categories : []).find(c => c && c.id === id);
    const name = hit && typeof hit.name === 'string' && hit.name ? hit.name : null;
    return name ? { state: CATEGORY.NAMED, id, name } : { state: CATEGORY.UNKNOWN, id, name: null };
}

/**
 * The chips above the grid: only categories that also actually have an agent, in the order of the category list, plus "No category" if there is an agent without one.
 *
 * A chip that filters to nothing is a dead button, so empty categories stay out. Agents with an unreadable category (`UNKNOWN`) get no chip of their own: they do not belong under "No category", and a chip "unknown" would suggest a category that does not exist. They remain reachable as long as no chip is active.
 *
 * @returns
 *   `name: null` on the chip with id NO_CATEGORY — the UI writes that one itself.
 */
export function categoryChipsOf(agents: readonly AgentListRow[] | null | undefined, categories?: readonly CategoryLike[] | null): CategoryChip[] {
    const rows = Array.isArray(agents) ? agents : [];
    const counts = new Map<string | undefined, number>();
    let noCategory = 0;
    for (const a of rows) {
        const cat = categoryOf(a, categories);
        if (cat.state === CATEGORY.NONE) { noCategory += 1; continue; }
        if (cat.state !== CATEGORY.NAMED) continue;
        counts.set(cat.id, (counts.get(cat.id) || 0) + 1);
    }
    const chips: CategoryChip[] = (Array.isArray(categories) ? categories : [])
        .filter(c => c && typeof c.id === 'string' && counts.has(c.id))
        .map(c => ({ id: c.id, name: c.name, count: counts.get(c.id) }));
    // Without even one named category there is nothing to filter against: then every agent is "no category" and the chip says nothing.
    if (chips.length > 0 && noCategory > 0) {
        chips.push({ id: NO_CATEGORY, name: null, count: noCategory });
    }
    return chips;
}

/**
 * "ANSWERS FROM MEMORY" IS NOT IN THIS FILE.
 *
 * Here stood `warnsNoKnowledge`, with a fallback on `counts.knowledge === 0` as soon as the server gave no judgement. That was a SECOND implementation of the rule that Studio's start screen (routes/studio/attentionChecks.js) reads from core/agentRuntime/agentGrounding.js, and the two already disagreed: a config with `knowledge_base_ids: 'kb-1'` (a string) is booked by the server as a GAP — "could not read the wiring", deliberately NOT an accusation — while the card put a red "No knowledge base" next to it.
 *
 * The warning now stands in one place on this screen: `./cardFooter.ts`, which reads only the word that the server sent (`grounding.verdict`). A row without that word (/agents/system, an older payload) yields silence, not a judgement of its own — unknown narrows. The knowledge PILL keeps showing its measured zero; that is a count, not a claim about behaviour.
 */

/** Alles waarop het zoekveld matcht, als één kleingeschreven string. */
function haystackOf(agent: AgentListRow | null | undefined, categories?: readonly CategoryLike[] | null) {
    const cat = categoryOf(agent, categories);
    return [agent?.name, agent?.description, cat.name]
        .map(v => (typeof v === 'string' ? v : ''))
        .join(' ')
        .toLowerCase();
}

/**
 * The shown part of the list: first the chip, then the search term.
 *
 * @param agents           the rows as the server gave them
 * @param opts.query       the search term ('' = everything)
 * @param opts.categoryId  active chip, `NO_CATEGORY`, or null
 * @param opts.categories  the read category list
 */
export function filterAgents<T extends AgentListRow>(
    agents: readonly T[] | null | undefined,
    { query = '', categoryId = null, categories = [] }: { query?: string; categoryId?: string | null; categories?: readonly CategoryLike[] } = {},
): readonly T[] {
    let rows = Array.isArray(agents) ? agents : [];
    if (categoryId === NO_CATEGORY) {
        rows = rows.filter(a => categoryOf(a, categories).state === CATEGORY.NONE);
    } else if (categoryId) {
        rows = rows.filter(a => categoryOf(a, categories).id === categoryId);
    }
    const q = String(query || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(a => haystackOf(a, categories).includes(q));
}
