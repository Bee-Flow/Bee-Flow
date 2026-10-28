// @typecheck strict
'use strict';

/**
 * nextcloud.file.tagged / file.untagged matcher, split out of filters.js
 * (which re-exports it). Leaf module.
 */

/** @typedef {Record<string, any>} TagPayload  the pushed tag event, plus the names dispatch.js may add */
/** @typedef {Record<string, any>} TagFilter  the trigger's filter as authored */

/**
 * True for a value that is a numeric Nextcloud id (`3`, `'3'`).
 * @param {unknown} v
 */
function isNumericId(v) {
    return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\d+$/.test(v.trim()));
}

/**
 * Tag names an event carries, lower-cased: the legacy `tagName` and the
 * `tagNames` the dispatcher looks up from the tag ids when a filter asks for
 * a name (triggerBus/dispatch.js, `tagNames` in ncVisibility.mts).
 * @param {TagPayload} payload
 * @returns {string[]}
 */
function payloadTagNames(payload) {
    /** @type {string[]} */
    const names = Array.isArray(payload.tagNames) ? payload.tagNames.filter((/** @type {unknown} */ n) => typeof n === 'string') : [];
    if (typeof payload.tagName === 'string' && payload.tagName) names.push(payload.tagName);
    return names.map(n => n.trim().toLowerCase());
}

/**
 * Does the event carry this tag? A numeric `tagId` is compared with the
 * event's ids, a name with the names the dispatcher looked up for them.
 * @param {TagPayload} payload
 * @param {unknown} tagId
 */
function tagIdMatches(payload, tagId) {
    if (!isNumericId(tagId)) return payloadTagNames(payload).includes(String(tagId).trim().toLowerCase());
    const ids = Array.isArray(payload.tagIds) ? payload.tagIds.map(String) : [];
    if (payload.tagId !== undefined && payload.tagId !== null) ids.push(String(payload.tagId));
    return ids.includes(String(tagId).trim());
}

/**
 * @param {TagPayload} payload
 * @param {TagFilter | null | undefined} filter
 */
function matchNextcloudTagFilter(payload, filter) {
    if (!filter) return true;
    // Nextcloud's TagAssignedEvent identifies the tag by numeric id only — it
    // carries no tag name. `tagId` takes either form: a number is compared
    // with the event's ids, a name with the names the dispatcher looked up for
    // those ids (case-insensitive; system tag names are unique per instance).
    // `tagName` is kept for filters saved against the older activity-feed
    // shape, which did include a name.
    if (filter.tagId !== undefined && filter.tagId !== null && filter.tagId !== '' && !tagIdMatches(payload, filter.tagId)) return false;
    if (filter.tagName && !payloadTagNames(payload).includes(String(filter.tagName).trim().toLowerCase())) return false;
    if (filter.tagAction && payload.tagAction !== filter.tagAction) return false;
    if (filter.pathPrefix && !(payload.path || '').startsWith(filter.pathPrefix)) return false;
    return true;
}

/**
 * Does this file.tagged / file.untagged filter name a tag by NAME (so the
 * dispatcher must look names up)? Checks the DSL's any / none clauses too.
 * @param {unknown} filter
 */
function tagFilterNeedsNames(filter) {
    if (!filter || typeof filter !== 'object') return false;
    const wants = (/** @type {unknown} */ f) => {
        if (!f || typeof f !== 'object') return false;
        const o = /** @type {TagFilter} */ (f);
        return (o.tagId !== undefined && o.tagId !== null && o.tagId !== '' && !isNumericId(o.tagId)) || !!o.tagName;
    };
    if (wants(filter)) return true;
    const f = /** @type {TagFilter} */ (filter);
    return ['any', 'none'].some(k => Array.isArray(f[k]) && f[k].some(wants));
}

module.exports = { matchNextcloudTagFilter, tagFilterNeedsNames, isNumericId };
