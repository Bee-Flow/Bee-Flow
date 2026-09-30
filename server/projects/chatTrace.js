// @typecheck
/**
 * "How I got this answer" for a team chat, as a normal chat shows it: what the
 * Privacy Shield replaced before the message went to the model, and what came
 * back. Two pieces per answer:
 *
 *   aiMeta   in the clear, tiny: the tier, and how many values were replaced
 *            and of what kind (never the values). It rides on every message.
 *   trace    only when something was replaced: the message as written, as the
 *            model saw it, the placeholders and what they stood for, and the
 *            model's answer with the placeholders still in. Sealed with the
 *            project key like the message itself, and served on request to
 *            whoever may read the chat (who could already read the message).
 */

'use strict';

/** Put the placeholders in for the values they stand for, longest value first so one never eats part of another. */
function applyTokenMap(text, tokenMap) {
    let out = String(text || '');
    const pairs = Object.entries(tokenMap || {}).filter(([, value]) => typeof value === 'string' && value)
        .sort((a, b) => b[1].length - a[1].length);
    for (const [token, value] of pairs) out = out.split(value).join(token);
    return out;
}

/**
 * @param {{ model: any, outbound: { tokenMap?: Record<string,string>|null, categories?: string[] }, triggerText: string,
 *           rawAnswer: string, box: any, chatId: string, messageId: string }} p
 * @returns {{ aiMeta: object, aiTrace: string|null }}
 */
function answerRecord({ model, outbound, triggerText, rawAnswer, box, chatId, messageId }) {
    const tokenMap = outbound.tokenMap || {};
    const redacted = Object.keys(tokenMap).length;
    const aiMeta = {
        tier: model.tier || null,
        requestedTier: model.requestedTier || null,
        redacted,
        categories: outbound.categories || [],
    };
    if (!redacted) return { aiMeta, aiTrace: null };
    const trace = {
        model: model.modelId || null,
        tier: model.tier || null,
        categories: outbound.categories || [],
        original: triggerText,
        sent: applyTokenMap(triggerText, tokenMap),
        tokenMap,
        returned: rawAnswer,
    };
    return { aiMeta, aiTrace: box.sealContent(chatId, `${messageId}:trace`, JSON.stringify(trace)) };
}

/** Open a stored trace; the fields a client may show, nothing else. */
function openTrace(box, chatId, messageId, stored) {
    const t = JSON.parse(box.openContent(chatId, `${messageId}:trace`, stored));
    const str = (x) => (typeof x === 'string' ? x : '');
    return {
        model: str(t.model) || null,
        tier: str(t.tier) || null,
        categories: Array.isArray(t.categories) ? t.categories.filter((c) => typeof c === 'string') : [],
        original: str(t.original),
        sent: str(t.sent),
        tokenMap: Object.fromEntries(Object.entries(t.tokenMap || {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')),
        returned: str(t.returned),
    };
}

module.exports = { applyTokenMap, answerRecord, openTrace };
