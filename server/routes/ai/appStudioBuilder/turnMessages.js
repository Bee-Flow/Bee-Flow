/**
 * App Studio Builder — how one turn's request is composed:
 *
 *   [system: byte-stable per (toolset, catalog, owner's routines)]
 *   [few-shots: a cached block — every turn on the small profile]
 *   [history: head-anchored window, evicted in whole blocks]
 *   [ONE user message: the machine notes (draft state, approved plan, editor
 *    context, plan policy, image note) followed by the user's own text]
 *
 * Why the last line matters twice. Before this the notes went out as up to
 * five consecutive role:'user' messages ahead of the human's — templates that
 * demand strict user/assistant alternation (Gemma, Mistral) reject that shape
 * (core/providers/local.js, the fold rationale), and every note is a fresh
 * message boundary the prefix cache cannot see past. One message keeps the
 * template happy and makes `notes + user text` the only bytes the local box
 * re-reads on a follow-up turn.
 *
 * Everything before the notes is a pure function of SESSION state (profile,
 * catalog, routines, history) — never of turn state — so two consecutive
 * turns share their prefix byte for byte. The fingerprint the route logs
 * proves it on the box.
 */

'use strict';

const { windowHistory, HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { isGemini3Model } = require('../builderShared');
const { buildFewShotMessages } = require('../../../appStudio/builderPrompt');
const { sanitizeHistory } = require('./turnLoop');

/**
 * The machine notes and the user's text as ONE role:'user' message. A
 * multimodal turn (the human attached images) keeps its content parts and is
 * led by one text part carrying the notes + framing text.
 */
function foldUserTurn(notes, userTurnContent) {
    const block = (Array.isArray(notes) ? notes : [])
        .filter((n) => typeof n === 'string' && n.trim())
        .join('\n\n');
    if (Array.isArray(userTurnContent)) {
        if (!block) return { role: 'user', content: userTurnContent };
        return { role: 'user', content: [{ type: 'text', text: block }, ...userTurnContent] };
    }
    const text = userTurnContent == null ? '' : String(userTurnContent);
    return { role: 'user', content: block ? `${block}\n\n${text}` : text };
}

/**
 * @param {object} p
 * @param {object} p.profile           getProfileForModel(...) result
 * @param {string} p.modelId
 * @param {string} p.sys               buildSystemPrompt(...) — byte-stable per session
 * @param {Array}  p.history           the persisted snapshot's messages (unsanitised)
 * @param {string[]} p.notes           machine notes, each already carrying its prefix
 * @param {string|Array} p.userTurnContent  the human's text, or multimodal parts
 * @returns {{ messages: Array, fewShotMessages: Array, windowedHistory: Array, userMessage: object }}
 */
function composeAppTurnMessages({ profile, modelId, sys, history, notes, userTurnContent }) {
    const prof = profile || {};
    const hist = sanitizeHistory(history);
    // Few-shots: on the small profile they stay every turn because they are a
    // cached block (dropping them on turn 2 shifts every later byte);
    // elsewhere only on a fresh session, where the prior turns are the better
    // example. Gemini 3.x rejects synthetic tool_calls without thought
    // signatures — none there (same guard as the routine builder).
    const fewShotCount = isGemini3Model(modelId) ? 0 : (prof.fewShots || 0);
    const wantFewShots = prof.fewShotPolicy === 'every-turn' || hist.length === 0;
    const fewShotMessages = (fewShotCount > 0 && wantFewShots)
        ? buildFewShotMessages(fewShotCount, { toolset: prof.toolset })
        : [];
    const windowedHistory = windowHistory(hist, {
        budgetTokens: prof.historyBudgetTokens,
        block: HISTORY_EVICT_BLOCK,
    });
    const userMessage = foldUserTurn(notes, userTurnContent);
    const messages = [
        { role: 'system', content: sys },
        ...fewShotMessages,
        ...windowedHistory,
        userMessage,
    ];
    return { messages, fewShotMessages, windowedHistory, userMessage };
}

/** Number of leading messages that are session-stable (system + few-shots + history). */
function stablePrefixLength(composed) {
    return 1 + (composed.fewShotMessages?.length || 0) + (composed.windowedHistory?.length || 0);
}

module.exports = { composeAppTurnMessages, foldUserTurn, stablePrefixLength, HISTORY_EVICT_BLOCK };
