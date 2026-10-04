// @typecheck
/**
 * Who contributed to a version, in the one shape notebooks, documents and the
 * project change feed share:
 *
 *   { userId: string|null, kind: 'user'|'ai', agentId?: string }
 *
 * A person is `{ userId, kind: 'user' }`. The AI is `{ kind: 'ai' }`, with the
 * agent that wrote when there is one, and with `userId` set to the person it
 * acted for when that is known ("Anna, with AI"); an AI edit nobody asked for
 * in particular (an automation, an auto-joining assistant) has `userId: null`.
 *
 * Only ids. A name is resolved when the list is SHOWN, with the reader's
 * access; a name copied in here would outlive a rename and an erasure.
 */

'use strict';

/** More than this many distinct contributors to one version is not a list anyone reads. */
const MAX_CONTRIBUTORS = 50;
const ID_MAX = 200;

/** @typedef {{ userId: string|null, kind: 'user'|'ai', agentId?: string }} Contributor */

const idOf = (v) => (typeof v === 'string' && v.trim() && v.length <= ID_MAX ? v.trim() : null);

/**
 * One contributor in the canonical shape, or null when it names nobody.
 * A person without an id is dropped (an unknown author is not "somebody");
 * the AI without an id is kept, because "the AI" is itself an answer.
 *
 * @param {unknown} raw
 * @returns {Contributor|null}
 */
function normalizeContributor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const c = /** @type {Record<string, unknown>} */ (raw);
    const userId = idOf(c.userId);
    if (c.kind === 'ai') {
        const agentId = idOf(c.agentId);
        return agentId ? { userId, kind: 'ai', agentId } : { userId, kind: 'ai' };
    }
    if (c.kind !== undefined && c.kind !== 'user') return null;
    return userId ? { userId, kind: 'user' } : null;
}

/** @param {Contributor} c */
const keyOf = (c) => `${c.kind}\u0000${c.userId || ''}\u0000${c.agentId || ''}`;

/**
 * Several contributor lists as one, first occurrence first, without
 * duplicates, capped at MAX_CONTRIBUTORS.
 *
 * @param {...unknown} lists
 * @returns {Contributor[]}
 */
function mergeContributors(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
            const c = normalizeContributor(raw);
            if (!c) continue;
            const key = keyOf(c);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(c);
            if (out.length >= MAX_CONTRIBUTORS) return out;
        }
    }
    return out;
}

/**
 * People as contributors: `contributorsFromUserIds(['u1','u2'])`.
 * @param {unknown} userIds
 * @returns {Contributor[]}
 */
function contributorsFromUserIds(userIds) {
    return mergeContributors(Array.isArray(userIds) ? userIds.map((userId) => ({ userId, kind: 'user' })) : []);
}

/** Did the AI take part? @param {unknown} list */
function hasAiContributor(list) {
    return Array.isArray(list) && list.some((c) => c && typeof c === 'object' && c.kind === 'ai');
}

module.exports = {
    normalizeContributor,
    mergeContributors,
    contributorsFromUserIds,
    hasAiContributor,
    MAX_CONTRIBUTORS,
};
