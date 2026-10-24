/**
 * The TESTCHAT (A4 part A).
 *
 * `POST /agents/:id/chat/stream` with `{ test: true }` is one ordinary turn in an
 * EPHEMERAL conversation, run on the DRAFT of the agent. This file is the only place that
 * records WHAT that means, so that the route, the runtime and the cost reporting do not each
 * invent their own answer.
 *
 * ── A TEST CONVERSATION IS NOT A CONVERSATION ───────────────────────────
 * Everywhere that conversations appear, a test conversation must mean the same thing, otherwise
 * the count in the other place is untrue. There is exactly one mechanism that guarantees that:
 * NO ROW IS WRITTEN. `ephemeral: true` skips the whole persistence (chatStream makes an
 * in-memory `ephemeral-<ts>`), and so the test conversation is by construction absent from:
 *
 *   • the history      — `listConversations` / `listAllConversations` /
 *                        `searchConversations` / `GET /:id/history`;
 *   • the overview footer A5 — `getAgentChatStats` counts rows of
 *                        `agent_conversations`;
 *   • the Used-by tab   — the same counter, via `gatherUsage`;
 *   • the DSR export    — which reads conversations (not yet, but later) from
 *                        the same table.
 *
 * An `is_test` column would do the opposite: then the row does exist and EVERY reader would need
 * a filter that a new reader next year forgets. Absence needs no readers.
 *
 * ── EXCEPT IN THE COSTS, AND THERE IT GETS ITS OWN NAME ────────────────
 * `usageStore.logUsage` also writes for an ephemeral turn — that is right, a test turn really
 * costs money on someone's key. But it wrote `source: 'agent_stream'` / `'agent_chat'`, and there a
 * test conversation WAS counted as an ordinary conversation. That is the one place that made the
 * count elsewhere untrue. A test turn now carries its own source, as the test-set run already did
 * with `agent_test_grade`. `COUNT(DISTINCT conversation_id)` over that source is the honest reading
 * of "n test conversations": one ephemeral conversation = one id = one test conversation.
 *
 * That last sentence is a REQUIREMENT on the id, not an observation. An ephemeral conversation got
 * its id per REQUEST (`ephemeral-<Date.now()>`), so `COUNT(DISTINCT …)` counted TURNS and a test
 * conversation of six messages reported six. `ephemeralConversationId` below makes the id STABLE
 * across the turns of one test conversation: the client carries its session key and the server
 * hashes it together with the user and the agent. Without a usable key the answer is random-and-new —
 * that counts too HIGH (every turn a conversation), and that is the side where nobody sees a
 * conversation that did not exist.
 *
 * ── AND IN THE AUDIT ROWS, UNDER THE SAME NAME AND A DRY-RUN FLAG ────
 * Usage was not the only thing that a test turn wrote. The input guardrails, the PII events around
 * a tool and the egress log all wrote hard `source: 'agent_stream'`, so an experiment of the builder
 * stood in the org privacy-shield activity between the production turns — linked to a
 * conversation_id that exists nowhere. Those five places now go through `usageSourceFor` and set
 * `isDryRunTurn`, exactly as the automation runner does for a dry run: `guardrail_events.is_dry_run`
 * already exists and the org shield already filters on it.
 *
 * ── IT RUNS ON THE DRAFT ──────────────────────────────────────────────
 * `chatWithAgentStream` normally loads via `getForRuntime`, and that serves the PUBLISHED config as
 * soon as there is a publication — exactly what R2 recorded for an AI step. A testchat does the
 * opposite, deliberately: you test what you are making. The difference is no detail that you may
 * keep quiet — whoever tests his draft and thinks he sees the live agent tests something other than
 * what runs. Therefore the runtime sends `test_chat` over the line with what was actually loaded
 * (`source`), what is live (`publishedVersion`) and how far the draft runs ahead of it
 * (`unpublishedChanges`).
 *
 * ── WHAT MUST NOT SILENTLY DISAPPEAR ──────────────────────────────────
 * A testchat runs REAL tools on REAL connections. Therefore in a testchat everything that does not
 * read is held back for a human (`holdsEffect`), even when the agent config says `direct` of it.
 * That is only stricter than an ordinary chat — it can never release a call that was previously held
 * back — and it makes the decision buttons on the card the real work instead of decoration.
 *
 * Run: cd server && node --test core/agentRuntime/testChat.test.js
 */

'use strict';

const crypto = require('crypto');
const { effectOf } = require('../automationModel/sideEffectMap');

/** De bron waaronder een testbeurt in `ai_usage_log` terechtkomt. */
const TEST_CHAT_USAGE_SOURCE = 'agent_test_chat';

/** Foutcodes van de poort. Zelfde vorm als TEST_AS_CODES. */
const TEST_CHAT_CODES = {
    notAllowed: 'test_chat_not_allowed',
    checkFailed: 'test_chat_check_failed',
};

/** Hoeveel beslissingen één verzoek mag meedragen. */
const MAX_TOOL_DECISIONS = 20;
/** Lengte van de sleutel die de kaart terugstuurt (hex). */
const ARGS_KEY_LENGTH = 32;
/**
 * The prefix of every ephemeral conversation id. A real row id is a uuid/nanoid, so this form can
 * never point to one — that is exactly what makes it safe to derive from client input.
 */
const EPHEMERAL_PREFIX = 'ephemeral-';

/**
 * Did the client ask for a testchat?
 *
 * Only a literal `true` counts. `'false'`, `0` and `''` are not a testchat — a string from a query
 * string that is read as truth is precisely how an ordinary turn accidentally becomes ephemeral and
 * disappears from the history.
 */
function wantsTestChat(body) {
    return !!body && body.test === true;
}

/** Draait DEZE beurt als testchat? Leest de metadata die de route zette. */
function isTestChat(messageMetadata) {
    return !!messageMetadata && messageMetadata.testChat === true;
}

/**
 * The gate: may this requester run a testchat?
 *
 * The same right that "Test as" asks for (A1c) and that `PUT /agents/:id` asks for: testing belongs to
 * building. A chatter who may use the agent should not be able to read the unpublished draft in
 * secret — that is a leak of work-in-progress, not only a convenience.
 *
 * Refuses; never degrades to an ordinary turn. A testchat that quietly runs the published config is
 * the one answer this route must never give.
 *
 * @returns {{ok:true, testChat:boolean}|{ok:false, status:number, error:string, code:string}}
 */
function gateTestChatRequest({ test, canEdit } = {}) {
    if (test !== true) return { ok: true, testChat: false };
    if (!canEdit) {
        return {
            ok: false, status: 403, code: TEST_CHAT_CODES.notAllowed,
            error: 'Only someone who can edit this agent can test it.',
        };
    }
    return { ok: true, testChat: true };
}

/**
 * The source under which this turn writes its usage.
 *
 * @param {object} messageMetadata
 * @param {string} fallback  what the call site wrote when this did not yet exist
 */
function usageSourceFor(messageMetadata, fallback) {
    return isTestChat(messageMetadata) ? TEST_CHAT_USAGE_SOURCE : fallback;
}

/**
 * Is this turn a DRY RUN for every audit reader?
 *
 * The same word the automation runner uses for a dry run (`core/automationRunner/execution.js`), so that
 * `guardrail_events.is_dry_run` keeps one meaning: real computing happened, a real scan happened, but this
 * was not a production turn and a dashboard that looks at production should not count it. The column already
 * exists and the org shield already filters on it — this only sets it for the testchat too.
 *
 * Deliberately a separate name next to `isTestChat`: the call sites below concern AUDIT, not runtime
 * behaviour, and a reader who sees `is_dry_run: isTestChat(m)` should not have to guess whether that is a
 * coincidence.
 */
function isDryRunTurn(messageMetadata) {
    return isTestChat(messageMetadata);
}

/**
 * The id of an EPHEMERAL conversation: stable across the turns of one session.
 *
 * Why this may not simply be `ephemeral-${Date.now()}`: `usageStore` counts test conversations with
 * `COUNT(DISTINCT conversation_id)`. With an id per REQUEST that counts TURNS, and a test conversation of
 * six messages reports six. The key makes the id stable as long as the client runs the same test session.
 *
 * Why the client's key does NOT become the id directly:
 *
 *   • the id travels along in `guardrail_events.conversation_id`, in the egress log and in the PII token-map
 *     memo (which hangs on the conversation id). A client that supplies a REAL conversation id would thereby
 *     address the token map of that conversation. Therefore it is hashed, with the `ephemeral-` prefix in front:
 *     that form can by construction not point to an existing row.
 *   • two users who happen to choose the same key must not land in the same ephemeral conversation. Therefore
 *     `userId` and `agentId` are in the hash — the key alone is not an address.
 *
 * Without a usable key: random and new. That counts too HIGH (every turn a conversation), and counting too high
 * lets nobody miss a conversation that was there — the reverse error, two sessions on one id, would do that.
 *
 * @param {object} p
 * @param {string} [p.sessionKey] what the client sends for this test session
 * @param {string} [p.userId]
 * @param {string} [p.agentId]
 */
function ephemeralConversationId({ sessionKey, userId, agentId } = {}) {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (key.length >= 8 && key.length <= 200) {
        const digest = crypto.createHash('sha256')
            .update(`ephemeral|${String(userId || '')}|${String(agentId || '')}|${key}`)
            .digest('hex')
            .slice(0, 32);
        return `${EPHEMERAL_PREFIX}${digest}`;
    }
    return `${EPHEMERAL_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * The session key as it may come from a request.
 *
 * An opaque string from the client, nothing more — it is hashed and never held against anything. Too short
 * or too long counts as "no key", and that yields a fresh id instead of a shared one.
 */
function normaliseSessionKey(raw) {
    if (typeof raw !== 'string') return null;
    const key = raw.trim();
    if (key.length < 8 || key.length > 200) return null;
    if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
    return key;
}

/**
 * What must be on screen about WHICH agent just ran.
 *
 * `runtimeSource` comes from the store projection and is the only honest answer: 'draft' is the draft,
 * 'published' the published blob, 'live' an agent that was never published (draft and live are then the same).
 *
 * A projection that said nothing is NOT silently the draft: then `source: 'unknown'` comes out and the screen
 * may show no reassurance. The reverse error — saying "you are testing your draft" while the published blob
 * ran — is exactly the lie that this whole function exists to prevent.
 *
 * WHAT THAT BRANCH IS AND IS NOT TODAY: on the testchat path `agentCrud.projectDraft` stamps `runtimeSource:
 * 'draft'` unconditionally, and a row that does not exist already throws 'Agent not found' earlier. 'published'
 * and 'unknown' are therefore not reachable there — they stand here as a FAIL-CLOSED default for the second call
 * site that the JSDoc of `ruleAttribution.attributeTurn` invites (`versionInfo(views)`), and for a projection that
 * may say something different tomorrow. They are not tested on this path because they do not occur on this path;
 * that is something other than "tested".
 */
function testChatConfigInfo(agent) {
    const src = agent && agent.runtimeSource;
    const source = (src === 'draft' || src === 'published' || src === 'live') ? src : 'unknown';
    const publishedVersion = Number(agent && agent.published_version) || 0;
    const rev = Number(agent && agent.rev) || 0;
    const publishedRev = Number(agent && agent.published_rev) || 0;
    return {
        source,
        // Is what you are making what runs? Only 'draft' and 'live' are that;
        // with 'unknown' we do not know, and that is not a yes.
        runsDraft: source === 'draft' || source === 'live',
        publishedVersion,
        agentRev: rev,
        // Hoe ver het concept voorloopt op wat er live staat. Zonder publicatie
        // is er niets om op voor te lopen.
        unpublishedChanges: publishedVersion > 0
            ? Math.max(0, (rev || 1) - publishedRev)
            : 0,
    };
}

/**
 * The key of one held-back call: the name plus exactly these arguments.
 *
 * This is the key that `toolRoundExecutor` already uses to show one card per action per turn
 * (`toolName|stableStringify(args)`), but hashed — the raw arguments may not cross the line, and certainly
 * not come back from a client. What the card sends back is therefore a claim about ONE action, not about
 * a tool: the same name with other arguments does not match.
 *
 * @param {string} toolName
 * @param {string} stableArgs  the result of `_stableStringify(args)`
 */
function argsKeyFor(toolName, stableArgs) {
    return crypto.createHash('sha256')
        .update(`${String(toolName)}|${String(stableArgs)}`)
        .digest('hex')
        .slice(0, ARGS_KEY_LENGTH);
}

/**
 * The decisions that the client sends along, cleaned up.
 *
 * A decision is one `{ toolName, argsKey, decision }`. Unknown narrows: anything that is not literally
 * 'approve' or 'decline' does not count — so also not `decision: 'approve '` or `true`. More than
 * MAX_TOOL_DECISIONS are cut off, because this is a card that a human clicked, not a batch.
 *
 * @returns {Map<string, 'approve'|'decline'>} argsKey → decision
 */
function normaliseToolDecisions(raw) {
    const out = new Map();
    if (!Array.isArray(raw)) return out;
    for (const d of raw) {
        if (out.size >= MAX_TOOL_DECISIONS) break;
        if (!d || typeof d !== 'object') continue;
        const decision = d.decision;
        if (decision !== 'approve' && decision !== 'decline') continue;
        const key = typeof d.argsKey === 'string' ? d.argsKey.trim() : '';
        if (!/^[0-9a-f]{8,64}$/.test(key)) continue;
        // The first decision about a key wins. A second line with a different outcome for the same
        // action is not a new permission.
        if (!out.has(key)) out.set(key, decision);
    }
    return out;
}

/**
 * Must a testchat hold this call even though the config says 'direct'?
 *
 * Everything that is not demonstrably reading. `effectOf` itself already falls back to 'writes' for a name
 * that it does not know, so an unknown tool is held back — the side that lets nothing happen.
 */
function holdsEffect(toolName, knownEffect) {
    const effect = knownEffect || (() => {
        try { return effectOf(toolName); } catch (_) { return 'writes'; }
    })();
    return effect !== 'reads';
}

module.exports = {
    TEST_CHAT_USAGE_SOURCE, TEST_CHAT_CODES, MAX_TOOL_DECISIONS, ARGS_KEY_LENGTH,
    EPHEMERAL_PREFIX,
    wantsTestChat, isTestChat, gateTestChatRequest, usageSourceFor, isDryRunTurn,
    testChatConfigInfo, argsKeyFor, normaliseToolDecisions, holdsEffect,
    ephemeralConversationId, normaliseSessionKey,
};
