/**
 * The footer of an agent card in the overview (A5, part D): one line, and which line that becomes.
 *
 * Three forms, and the choice between them is the whole function:
 *
 *   ⚠ Answers from memory — connect a knowledge base
 *   312 conversations · also in 2 automations, 1 app
 *   Only you · 4 test conversations
 *
 * ── THE WARNING IS NOT FROM THIS FILE ──────────────────────────────────────
 *
 * "Answers from memory" is a RULE, and that rule lives on the server:
 * core/agentRuntime/agentGrounding.js `groundedOn` + `groundingVerdict`, which
 * Studio's "Needs attention" (routes/studio/attentionChecks.js, source
 * `agentNoKb`) also reads. GET /agents/all attaches the answer to every row as
 * `grounding.verdict`, and this file READS that word — it derives nothing from
 * `config.knowledge_base_ids`.
 *
 * Why that is worth the trouble: two implementations of the same sentence drift
 * apart, and the first screen where that shows is exactly the screen where someone
 * sees them side by side — Start says "needs attention" about an agent that the
 * overview says nothing about. The same argument that
 * admin/Studio/attention/attentionChecks.js makes in its header about the other
 * five sources.
 *
 * ── WHAT THE COUNTS ARE ABOUT, AND WHAT NOT ────────────────────────────────
 *
 * `stats` comes from stores/agent/agentStats.js `getAgentChatStats`: ONE
 * GROUP BY over `agent_conversations` on `agent_id`, WITHOUT a filter on user. So
 * `conversationCount` is "conversations WITH THIS AGENT, by everyone" and
 * `userCount` is `COUNT(DISTINCT user_id)`. Two consequences:
 *
 *   1. The sentence may never say "your conversations" — that would put a number
 *      of colleagues under your name.
 *   2. "Only you" is a CLAIM about scope and needs EVIDENCE, and `userCount` is not
 *      that evidence: it is COUNT(DISTINCT user_id) over ALL conversations, so one
 *      counts just as much as a colleague who conducted forty while you conducted
 *      none. That is exactly what happens: you publish an agent, a colleague uses it,
 *      you set it back to draft (`setAgentPublished` does a single UPDATE — the rows
 *      in `agent_conversations` stay), and the card would say "Only you · 40
 *      conversations" about conversations that are not yours.
 *      The evidence that does carry it is `othersConversationCount`
 *      (`COUNT(*) FILTER (WHERE user_id <> you)`), and that has been riding along on
 *      the list since A5 — no extra query, the same GROUP BY with one parameter added.
 *      `null` there means "the server could not see who is looking", and then the
 *      form does not appear.
 *
 * ── A COUNT THAT COULD NOT BE READ IS NOT A 0 ─────────────────────────────
 *
 * `stats: null` is the server's answer to a failed reading, and a row without the
 * field is the same. Both become `null` — never 0. "312 conversations" and "the
 * number could not be read" are different sentences, and the second may not be read
 * as the first with a nought. Same rule as `countOrNothing` in
 * builderSplit/AgentEditorHeader.jsx and as `summariseDeleteBlock` next door.
 *
 * For "used by" the same rule applies twice:
 *   - without `?usage=1` the field is ABSENT, and then the footer says nothing
 *     about it (absent ≠ "used by nothing");
 *   - `usage.partial` names the kinds that nobody could check, and those do not count
 *     as zero — they get their own half sentence.
 *
 * Pure and without rendering, like ./deleteBlock.ts: the words stand in
 * AgentCardFooter.jsx, where the i18n guard can read the keys.
 */

// The same six kinds in the same order as the delete dialog, from the same mirror of
// stores/agent/agentUsage.js KINDS. One list for both screens; a seventh kind that the
// server adds later comes in through `counts` and is reported under its own name instead
// of being left out.
import { USAGE_KINDS } from './deleteBlock';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What the footer line says, and which of the three lines it is. */
export interface CardFooterSummary {
    variant: 'ungrounded' | 'private' | 'counts';
    statsAsked: boolean;
    conversations: number | null;
    people: number | null;
    usageAsked: boolean;
    usedBy: Array<{ kind: string; count: number | null }>;
    unchecked: string[];
}

/**
 * A finite, non-negative integer, or `null`. Never a 0 out of nothing.
 *
 * The sieve up front is the whole point: `Number(null)`, `Number('')` and `Number(false)`
 * are all three `0` — finite and ≥ 0 — so without that sieve a per-field null (a LEFT JOIN
 * that drops out, a COALESCE that disappears) would read as the CLAIM "0 conversations"
 * instead of "could not be read". The same sieve that `documentCountOf` in
 * server/routes/studio/attentionChecks.js puts up front.
 */
function countOrNull(value: unknown) {
    // Only a number, or a string that is one. Anything that `Number()` silently turns into 0
    // outside those two kinds (`null`, `''`, `false`, `[]`) is UNKNOWN here.
    const numeric = typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '');
    if (!numeric) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * The server's judgement about what this agent is grounded on.
 *
 * ONLY the word that the server sent counts. `grounding` absent (an older client, a list
 * that does not carry the field), not an object, or a `verdict` that this file does not
 * know ⇒ `null` = "not established", and silence belongs with that, not a warning. The
 * axes (`kb`/`tables`/`web`) travel along for context but are NOT processed again into a
 * judgement here — that would be the second implementation that this file avoids.
 *
 */
export function groundingVerdictOf(agent: unknown): 'grounded' | 'ungrounded' | null {
    const g = isObj(agent) ? agent.grounding : null;
    if (!isObj(g)) return null;
    return g.verdict === 'grounded' || g.verdict === 'ungrounded' ? g.verdict : null;
}

/** De volgorde waarin een mens de soorten leest. Onbekende soort: achteraan. */
function kindOrder(kind: string) {
    const i = USAGE_KINDS.indexOf(kind);
    return i === -1 ? USAGE_KINDS.length : i;
}

const byKind = (a: string, b: string) => kindOrder(a) - kindOrder(b) || String(a).localeCompare(String(b));

/**
 * The "used by" half: what was found, and what nobody could check.
 *
 * Three outcomes, not two. The field is there only with `?usage=1`; absent ⇒ nothing is
 * said about it, and an empty object would claim "used by nothing" about a pass that never
 * ran. A kind in `partial` is not zero, and a `partial` that is itself not a list is an
 * unreadable answer about ALL kinds — the same narrow reading that `summariseDeleteBlock`
 * next door makes.
 */
function usageHalf(usage: unknown) {
    if (!isObj(usage)) return { usageAsked: false, usedBy: [], unchecked: [] };
    const counts = isObj(usage.counts) ? usage.counts : {};
    return {
        usageAsked: true,
        usedBy: Object.entries(counts)
            .map(([kind, n]) => ({ kind, count: countOrNull(n) }))
            .filter(u => u.count !== null && u.count > 0)
            .sort((a, b) => byKind(a.kind, b.kind)),
        unchecked: Array.isArray(usage.partial)
            ? usage.partial.filter(k => typeof k === 'string' && k).sort(byKind)
            : [...USAGE_KINDS],
    };
}

/**
 * May this footer say "only you"?
 *
 * Four conditions, and all four are evidence for that one claim: the agent is not published
 * (nobody else can reach it now), you are the owner, and NO conversation by someone else is
 * in there — counted, not assumed. `is_published` may not be MISSING: absent is unknown, and
 * unknown narrows to the neutral form.
 *
 * `others === null` blocks the form. That is the case in which the server did not know who
 * was looking (no `excludeUserId`), and then the FILTER ran over all rows: a 0 would claim
 * "nobody else" there without evidence.
 */
function onlyYou(row: Record<string, unknown> | null, viewerId: string | null, others: number | null) {
    const published = row?.is_published ?? row?.isPublished;
    const owner = row?.owner_id ?? row?.ownerId;
    const mine = !!viewerId && !!owner && String(owner) === String(viewerId);
    return published === false && mine && others === 0;
}

/**
 * May the "answers from memory" warning appear on this row?
 *
 * The CRITERION is on the server (core/agentRuntime/agentGrounding.js) and is only read
 * here. What stands here is the BOUNDARY, and that is a mirror of the `WHERE` of Studio's
 * attention list (routes/studio/attentionChecks.js: `owner_id NOT IN ('system','swarm') AND
 * is_published = TRUE`). Two reasons to take it over:
 *
 *   - a draft without a knowledge base is an agent that is being BUILT, and reporting that
 *     makes noise on every newly created card. Without this boundary the overview shouted
 *     about agents that the start screen deliberately stays silent about;
 *   - `is_published` may not be MISSING: unknown narrows to silence.
 *
 * And one boundary that H3 does not have but this card does need: the grounding is calculated
 * over the DRAFT config. For a row with `published_version > 0` the runtime serves
 * `published_config`, and that blob never leaves the store (`agentCrud._stripPublishedBlobs`).
 * Directly under a pill that says "LIVE v8", making a statement about a version that is not
 * running is a contradiction on one card, so the footer is silent there. For H3 — a work list
 * for the builder — the draft is precisely the right column; hence the difference.
 */
function warnsUngrounded(row: Record<string, unknown> | null) {
    if (groundingVerdictOf(row) !== 'ungrounded') return false;
    const published = row?.is_published ?? row?.isPublished;
    if (published !== true) return false;
    const version = Number(row?.published_version ?? row?.publishedVersion ?? 0);
    return !(Number.isFinite(version) && version > 0);
}

/**
 * What is stated in the footer of this card.
 *
 * @param agent  one row of GET /agents/all
 * @param viewerId  who is looking; without this "only you" cannot be true
 *   and that form does not appear
 */
export function summariseCardFooter(agent: unknown, viewerId: string | null = null): CardFooterSummary {
    const row = isObj(agent) ? agent : null;

    // THREE ANSWERS, NOT TWO. A row WITHOUT the `stats` field comes from a route that never
    // calculated the counts (/agents/system) — there is nothing to say about that. `stats: null`
    // is a route that DID try and failed, and that deserves words. A 0 that the server counted
    // stays a 0.
    const statsAsked = !!row && 'stats' in row;
    const stats = isObj(row?.stats) ? row.stats : null;
    const conversations = stats ? countOrNull(stats.conversationCount) : null;
    const people = stats ? countOrNull(stats.userCount) : null;
    const others = stats ? countOrNull(stats.othersConversationCount) : null;
    const facts = { statsAsked, conversations, people, ...usageHalf(row?.usage) };

    // The warning goes first: it is the only one of the three that asks for something. Only a
    // HARD 'ungrounded' from the server counts, and only within the boundary above; "not
    // established" does not warn.
    if (warnsUngrounded(row)) return { variant: 'ungrounded', ...facts };
    if (onlyYou(row, viewerId, others)) return { variant: 'private', ...facts };
    return { variant: 'counts', ...facts };
}
