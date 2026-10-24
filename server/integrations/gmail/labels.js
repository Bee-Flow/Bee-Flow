// @typecheck
/**
 * Gmail labels: the per-session label list cache and name-to-id resolution.
 */

'use strict';

/**
 * The mailbox's labels, kept for a minute per session. Labelling a message
 * resolves its label names first, and in a run that labels every email of a
 * search that was one labels.list request per email on top of the change
 * itself.
 */
const LABEL_CACHE_MS = 60_000;
const labelCache = new WeakMap();

function rememberLabels(cacheKey, labels) {
    if (cacheKey && typeof cacheKey === 'object') labelCache.set(cacheKey, { at: Date.now(), labels });
}

async function listLabels(gmail, cacheKey, { fresh = false } = {}) {
    const hit = cacheKey && typeof cacheKey === 'object' ? labelCache.get(cacheKey) : null;
    if (!fresh && hit && Date.now() - hit.at < LABEL_CACHE_MS) return { labels: hit.labels, cached: true };
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    rememberLabels(cacheKey, labels);
    return { labels, cached: false };
}

/**
 * Resolve a mix of label names and label IDs to label IDs. System labels
 * (INBOX, UNREAD, STARRED, …) already use their name as the ID; user-label
 * names (e.g. "Work") are looked up to their `Label_N` id. Unknown entries
 * pass through unchanged so callers can supply raw IDs directly.
 *
 * With a `cacheKey` (the session) the label list is reused for a minute; a
 * name the cached list does not know (a label made since) asks Gmail once more.
 */
async function resolveLabelIds(gmail, entries, cacheKey = null) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : (entries ? [entries] : []);
    if (!list.length) return [];
    const lookup = (labels) => {
        const byId = new Map(labels.map(l => [l.id, l.id]));
        const byName = new Map(labels.map(l => [String(l.name).toLowerCase(), l.id]));
        return (entry) => byId.get(entry) || byName.get(String(entry).toLowerCase()) || null;
    };
    let { labels, cached } = await listLabels(gmail, cacheKey);
    let find = lookup(labels);
    if (cached && list.some(entry => !find(entry))) {
        ({ labels } = await listLabels(gmail, cacheKey, { fresh: true }));
        find = lookup(labels);
    }
    return list.map(entry => find(entry) || entry);
}

module.exports = { rememberLabels, listLabels, resolveLabelIds };
