// @typecheck
'use strict';

/**
 * Build-time advice for an app_event trigger. The builder used to store
 * `appEvent` and `filter` as given, so an automation on an event nothing
 * produces, an event that does not exist or a filter key nothing reads was
 * accepted and then silently never fired (or fired on everything). These are
 * plain-text WARNINGS in the tool result, never errors: declarations are per
 * install and a half-built trigger is a normal intermediate state.
 */

const { PUSH_PENDING } = require('../deliverableEvents');
const { fallback } = require('../../utils/bestEffort');

// Keys the rich filter DSL (triggers/dslFilters.js) adds on top of any event.
const DSL_KEYS = ['any', 'none', 'expr', 'age'];

const FILE_KEYS = ['inFolder', 'extension', 'nameContains', 'excludeOwnUploads'];
const CALENDAR_KEYS = ['calendarId', 'calendarUri', 'summaryContains', 'attendeeContains'];
const TALK_MESSAGE_KEYS = ['roomToken', 'roomNameContains', 'actorEquals', 'messageContains', 'excludeOwnMessages'];
const SHARE_KEYS = ['actorEquals', 'nameContains', 'kindEquals'];
const DECK_KEYS = ['boardId', 'stackId', 'titleContains', 'archived'];

/** @type {Record<string, string[]>} filter keys the Nextcloud matchers (triggerBus/filters.js) read, per event. */
const NEXTCLOUD_FILTER_KEYS = {
    'file.new': FILE_KEYS,
    'file.changed': FILE_KEYS,
    'file.deleted': FILE_KEYS,
    'file.renamed': FILE_KEYS,
    'file.commented': ['pathPrefix', 'actorEquals', 'messageContains'],
    'file.tagged': ['tagId', 'tagName', 'tagAction', 'pathPrefix'],
    'file.untagged': ['tagId', 'tagName', 'tagAction', 'pathPrefix'],
    'forms.submitted': ['formId', 'formHash', 'titleContains', 'submittedByEquals'],
    'tables.row.added': ['tableId', 'actorEquals', 'columnId', 'valueEquals', 'valueContains', 'changedOnly'],
    'tables.row.updated': ['tableId', 'actorEquals', 'columnId', 'valueEquals', 'valueContains', 'changedOnly'],
    'tables.row.deleted': ['tableId', 'actorEquals', 'columnId', 'valueEquals', 'valueContains', 'changedOnly'],
    'calendar.event.created': CALENDAR_KEYS,
    'calendar.event.changed': CALENDAR_KEYS,
    'calendar.event.deleted': CALENDAR_KEYS,
    'calendar.event.upcoming': [...CALENDAR_KEYS, 'leadMinutes', 'includeAllDay', 'calendar'],
    'talk.message.received': TALK_MESSAGE_KEYS,
    'talk.mention.received': TALK_MESSAGE_KEYS,
    'talk.reaction.added': ['roomToken', 'roomNameContains', 'actorEquals', 'reaction', 'includeRemoved'],
    'share.received': SHARE_KEYS,
    'share.created': [...SHARE_KEYS, 'shareType'],
    'share.accepted': [...SHARE_KEYS, 'shareType'],
    'share.deleted': [...SHARE_KEYS, 'shareType'],
    'activity.new': ['type', 'objectNameContains', 'actorEquals'],
    'notification.new': ['app', 'subjectContains'],
    'deck.card.created': DECK_KEYS,
    'deck.card.changed': DECK_KEYS,
    'deck.card.deleted': DECK_KEYS,
    'deck.card.completed': DECK_KEYS,
    'deck.card.moved': [...DECK_KEYS, 'fromStackId', 'toStackId'],
};

/** @param {unknown} v */
function isNumericId(v) {
    return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\d+$/.test(v.trim()));
}

/**
 * @param {string} provider
 * @param {string} event
 * @param {unknown} filter
 * @returns {string[]}
 */
function filterWarnings(provider, event, filter) {
    if (provider !== 'nextcloud' || !filter || typeof filter !== 'object' || Array.isArray(filter)) return [];
    const known = NEXTCLOUD_FILTER_KEYS[event];
    if (!known) return [];
    const f = /** @type {Record<string, unknown>} */ (filter);
    const out = [];
    const unknown = Object.keys(f).filter(k => !known.includes(k) && !DSL_KEYS.includes(k));
    if (unknown.length) {
        out.push(`filter key${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `"${k}"`).join(', ')} not read for ${provider}.${event} and will be ignored. Filters this event understands: ${known.join(', ')}.`);
    }
    if ((event === 'file.tagged' || event === 'file.untagged') && f.tagId !== undefined && f.tagId !== null && f.tagId !== '' && !isNumericId(f.tagId)) {
        out.push('filter.tagId must be the numeric Nextcloud tag id (one value): a tag name or a list never matches. Use tagName for a name.');
    }
    if ((event === 'calendar.event.created' || event === 'calendar.event.changed' || event === 'calendar.event.deleted') && f.summaryContains) {
        out.push('filter.summaryContains never matches on calendar.event.created / changed / deleted: the pushed event carries no summary. Filter on calendarId, or add a condition step after reading the event.');
    }
    return out;
}

/**
 * @param {{ provider?: string|null, event?: string|null, filter?: unknown }} appEvent
 * @returns {string[]} plain-text warnings; empty when the trigger looks deliverable
 */
function appEventWarnings(appEvent) {
    const provider = appEvent?.provider;
    const event = appEvent?.event;
    if (!provider || !event) return [];
    const out = [];
    let registryLoaded = false;
    /** @type {{ events?: { id: string }[] } | null} */
    let source = null;
    try {
        const ts = require('../triggerSources');
        registryLoaded = ts.listTriggerSources().length > 0;
        source = ts.getTriggerSource(provider) || null;
    } catch (e) { fallback('automation/builderTools/triggerAdvice:appEventWarnings', e); /* [triggerAdvice] trigger registry unavailable: */ }
    if (registryLoaded) {
        const offered = (source?.events || []).map(e => e.id);
        if (!source) {
            out.push(`No integration on this install provides events for "${provider}": this trigger cannot fire.`);
        } else if (!offered.includes(event)) {
            out.push(`"${provider}" provides no event "${event}": this trigger cannot fire. Available: ${offered.join(', ')}.`);
        }
    }
    if (/** @type {Record<string, Set<string>>} */ (PUSH_PENDING)[provider]?.has(event)) {
        out.push(`${provider}.${event} has no producer (Nextcloud exposes no webhook for it and there is no poller): this automation will NEVER fire. Pick another event, or use a schedule trigger that reads the data with a tool.`);
    }
    out.push(...filterWarnings(provider, event, appEvent.filter));
    return out;
}

module.exports = { appEventWarnings, filterWarnings, NEXTCLOUD_FILTER_KEYS };
