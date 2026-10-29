// @typecheck strict
/**
 * Nextcloud Talk tools — messages, reactions and polls in a conversation
 * (the chat half of executeNextcloudTalkTool, nextcloudTalkTools.js, which
 * resolves the auth and dispatches here). Each returns the tool result; a
 * failure is an `{ error }` result, never a throw.
 */

'use strict';

const { nextcloudHttpError } = require('./nextcloudHttpError');
const { mapMessage, pollError, bareVoteKeys, REACTION_SYSTEM_MESSAGES } = require('./nextcloudTalkMappers');
const { readJsonSafe, v1, COMMON_HEADERS } = require('./nextcloudTalkHttp');

/**
 * @typedef {import('./nextcloudClient.types').NcAuth} NcAuth
 * @typedef {{
 *   token?: string, limit?: number, lookIntoFuture?: number, query?: unknown, message?: string, replyTo?: number,
 *   silent?: unknown, messageId?: string | number, reaction?: string, question?: string, options?: unknown,
 *   resultMode?: unknown, maxVotes?: unknown, pollId?: string | number, optionIds?: unknown,
 * }} TalkArgs  the arguments of the chat tools, as the model sent them
 * @typedef {import('./nextcloudTalkMappers').RawTalkMessage} RawTalkMessage
 * @typedef {{ title?: string, subline?: string, resourceUrl?: string, icon?: string,
 *   attributes?: { conversation?: string, [k: string]: unknown } }} SearchEntry  one hit of the talk-message search provider
 */

/**
 * The newest messages of a conversation, reaction notices left out.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function listMessages(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token) return { error: 'token is required' };
    const limit = Math.min(Math.max(args.limit || 50, 1), 200);
    const url = `${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?lookIntoFuture=${args.lookIntoFuture || 0}&limit=${limit}&format=json`;
    const res = await ncFetch(url, { headers: COMMON_HEADERS });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Room not found: ${args.token}` };
    if (res.status === 304) return { token: args.token, count: 0, messages: [] };
    if (!res.ok) return { error: `Talk message fetch failed (${res.status})` };
    const data = await readJsonSafe(res);
    const raw = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
    const messages = raw.filter((/** @type {RawTalkMessage} */ m) => !REACTION_SYSTEM_MESSAGES.has(m.systemMessage ?? '')).map(mapMessage);
    return { token: args.token, count: messages.length, messages };
}

/**
 * Messages matching a search term across the user's conversations, each with the conversation it belongs to.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function searchMessages(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const q = String(args.query || '').trim();
    if (!q) return { error: 'query is required' };
    const limit = Math.min(Math.max(args.limit || 25, 1), 100);
    const url = `${baseUrl}/ocs/v2.php/search/providers/talk-message/search?term=${encodeURIComponent(q)}&limit=${limit}&format=json`;
    const res = await ncFetch(url, { headers: COMMON_HEADERS });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Talk search failed (${res.status})` };
    const data = await readJsonSafe(res);
    const entries = data?.ocs?.data?.entries || [];
    return {
        query: q,
        count: entries.length,
        messages: entries.slice(0, limit).map((/** @type {SearchEntry} */ e) => ({
            title: e.title,
            subline: e.subline,
            resourceUrl: e.resourceUrl,
            icon: e.icon,
            attributes: e.attributes,
            // The conversation each hit belongs to, promoted to a
            // first-class field. Talk's provider puts it in
            // attributes.conversation; the resourceUrl (/call/<token>)
            // is the fallback. Without it a hit cannot be placed in a
            // room, which is why this tool would be refused outright
            // whenever a user had narrowed Talk to specific rooms.
            token: e.attributes?.conversation
                ?? (/\/call\/([A-Za-z0-9]+)/.exec(e.resourceUrl || '')?.[1] ?? null),
        })),
    };
}

/**
 * Post a message (optionally a reply, optionally silent) to a conversation.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function sendMessage(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token || !args.message) return { error: 'token and message are required' };
    const body = {
        message: args.message,
        replyTo: args.replyTo || 0,
        silent: !!args.silent,
    };
    const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}?format=json`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Room not found: ${args.token}` };
    if (res.status === 413) return { error: 'Message too long.' };
    if (!res.ok && res.status !== 201) {
        const err = await readJsonSafe(res);
        return { error: `Talk send failed (${res.status})`, detail: err };
    }
    const data = await readJsonSafe(res);
    return data?.ocs?.data ? { success: true, message: mapMessage(data.ocs.data) } : { success: true };
}

/**
 * Delete one of the user's own messages.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function deleteMessage(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token || !args.messageId) return { error: 'token and messageId are required' };
    const res = await ncFetch(`${v1(baseUrl)}/chat/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
        method: 'DELETE',
        headers: COMMON_HEADERS,
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Message not found: ${args.messageId}` };
    if (res.status === 405) return { error: 'Message cannot be deleted: it may already be deleted, be too old, or not be your own.' };
    if (!res.ok && res.status !== 200 && res.status !== 202) return nextcloudHttpError(res, { authError, what: 'message delete', app: 'Talk' });
    return { success: true, messageId: args.messageId };
}

/**
 * Add (nextcloud_talk_add_reaction) or remove (nextcloud_talk_remove_reaction) an emoji reaction on a message.
 * @param {string} toolName
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function reactToMessage(toolName, args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token || !args.messageId || !args.reaction) return { error: 'token, messageId, reaction required' };
    const method = toolName === 'nextcloud_talk_add_reaction' ? 'POST' : 'DELETE';
    const res = await ncFetch(`${v1(baseUrl)}/reaction/${encodeURIComponent(args.token)}/${encodeURIComponent(args.messageId)}?format=json`, {
        method,
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction: args.reaction }),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) {
        return { error: method === 'POST'
            ? `Message ${args.messageId} not found in this conversation, so it cannot be reacted to.`
            : `Nothing to remove: message ${args.messageId} was not found, or you have no "${args.reaction}" reaction on it.` };
    }
    if (res.status === 400) {
        return { error: method === 'POST'
            ? `Reaction "${args.reaction}" was refused: it must be a single emoji, and you may not have reacted with it already.`
            : `Reaction "${args.reaction}" could not be removed: it must be the exact emoji you used.` };
    }
    if (!res.ok && res.status !== 200 && res.status !== 201) return nextcloudHttpError(res, { authError, what: 'reaction', app: 'Talk' });
    return { success: true };
}

/**
 * Open a poll in a conversation.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function createPoll(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token) return { error: 'token is required' };
    if (!args.question) return { error: 'question is required' };
    const options = Array.isArray(args.options) ? args.options.map(o => String(o ?? '').trim()) : [];
    if (options.some(o => !o)) return { error: 'options must not contain empty choices' };
    if (options.length < 2) return { error: 'options must contain at least two choices' };
    const res = await ncFetch(`${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}?format=json`, {
        method: 'POST',
        headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: args.question,
            options,
            resultMode: Number(args.resultMode || 0),
            maxVotes: Number(args.maxVotes || 0),
        }),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return pollError(res, authError, 'create');
    const data = await res.json().catch(() => null);
    const poll = data?.ocs?.data || {};
    return { success: true, pollId: poll.id ?? null, question: poll.question || args.question, options };
}

/**
 * A poll's question, options, votes (keyed by the bare 0-based option index) and status.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function getPoll(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token) return { error: 'token is required' };
    if (args.pollId === undefined) return { error: 'pollId is required' };
    const res = await ncFetch(
        `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
        { headers: COMMON_HEADERS },
    );
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Poll ${args.pollId} not found in that conversation.` };
    if (!res.ok) return pollError(res, authError, 'lookup');
    const data = await res.json().catch(() => null);
    const p = data?.ocs?.data || {};
    return {
        pollId: p.id ?? args.pollId,
        question: p.question || '',
        options: p.options || [],
        // `votes` is keyed by the bare 0-based option index (Talk's "option-<index>" is
        // normalised); `numVoters` is the headcount.
        votes: bareVoteKeys(p.votes),
        numVoters: p.numVoters ?? null,
        // 0 = open, 1 = closed.
        status: p.status === 1 ? 'closed' : 'open',
        resultMode: p.resultMode ?? null,
    };
}

/**
 * Vote on a poll with 0-based option indexes.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function votePoll(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token) return { error: 'token is required' };
    if (args.pollId === undefined) return { error: 'pollId is required' };
    const rawIds = Array.isArray(args.optionIds) ? args.optionIds : [];
    const optionIds = rawIds.map(n => (typeof n === 'string' && n.trim() === '' ? NaN : Number(n)));
    if (optionIds.some(n => !Number.isInteger(n) || n < 0)) {
        return { error: 'optionIds must be 0-based option indexes (non-negative integers)' };
    }
    if (!optionIds.length) return { error: 'optionIds must contain at least one 0-based option index' };
    const res = await ncFetch(
        `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
        {
            method: 'POST',
            headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ optionIds }),
        },
    );
    if (res.status === 401) return { error: authError };
    if (!res.ok) return pollError(res, authError, 'vote');
    return { success: true, pollId: args.pollId, optionIds };
}

/**
 * Close a poll.
 * @param {TalkArgs} args
 * @param {NcAuth} ctx
 */
async function closePoll(args, ctx) {
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    if (!args.token) return { error: 'token is required' };
    if (args.pollId === undefined) return { error: 'pollId is required' };
    const res = await ncFetch(
        `${v1(baseUrl)}/poll/${encodeURIComponent(args.token)}/${encodeURIComponent(args.pollId)}?format=json`,
        { method: 'DELETE', headers: COMMON_HEADERS },
    );
    if (res.status === 401) return { error: authError };
    if (!res.ok) return pollError(res, authError, 'close');
    return { success: true, pollId: args.pollId, status: 'closed' };
}

module.exports = {
    listMessages, searchMessages, sendMessage, deleteMessage, reactToMessage,
    createPoll, getPoll, votePoll, closePoll,
};
