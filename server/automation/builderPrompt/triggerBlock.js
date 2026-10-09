/**
 * The `## Triggers` block of the LEAN system prompt.
 *
 * The app-event knowledge — which events exist, which filter keys each one
 * honours, what its payload carries — lived in ONE place for the small band:
 * the 12.5 kB prose of builder_propose_trigger's description (schemas.js).
 * The lean schema projection cuts that description to a paragraph, so the
 * knowledge moves here, in the shape a 3.8B-active model reads best: one line
 * per event family, keys in brackets, payload after an arrow, the one caution
 * that matters at the end.
 *
 * Two sources, deliberately:
 *   - event ids and payload fields come from the DECLARATIONS
 *     (triggerSources/declared/*.js via the global registry), so a renamed or
 *     removed event cannot survive here;
 *   - filter keys and cautions come from TRIGGER_PROMPT_NOTES below, verified
 *     by hand against the matchers in triggerBus/filters.js and the pollers
 *     in triggerBus.js — the declarations do not carry filter keys, and the
 *     generic fallback matcher (exact equality on a payload field) is what an
 *     event without a custom matcher gets. triggerBlock.test.js pins every
 *     listed key to a `filter.<key>` read in one of those two files, so a
 *     key that stops being read stops being promised.
 *
 * GLOBAL registry only (listTriggerSources, never the per-org list): the
 * block sits in the system prompt, the front of the prompt cache on the
 * single-slot local box, and must be byte-identical across users and
 * sessions. Rendered once per process and memoised.
 */

'use strict';

const { listTriggerSources } = require('../triggerSources');
const { pickMatcher } = require('../triggerBus/filters');
const { matchFilter } = require('../triggers/dslFilters');
const { PUSH_PENDING } = require('../deliverableEvents');

/**
 * Sidecar notes keyed `provider.event`.
 *   filters      the keys the matcher / poller reads (verified, see header);
 *                a parenthesis after a key is prose the model needs beside it,
 *                and `a + b` names two keys that only work together
 *   fields       the payload fields worth naming (a subset of the declared
 *                list, plus `extraFields` for enriched keys the declaration
 *                omits but the producer always sets)
 *   extraFields  enriched payload keys, each with where it was verified
 *   group        events sharing one line (same filters, same payload)
 *   note         one caution, only where the recorded builds needed it
 */
const TRIGGER_PROMPT_NOTES = Object.freeze({
    'gmail.mail.new': {
        filters: ['from', 'to', 'subjectContains', 'labelIds', 'hasAttachment', 'excludeFromSelf'],
        fields: ['messageId', 'threadId', 'from', 'to', 'subject', 'snippet', 'date', 'labelIds', 'hasAttachment', 'attachments[{attachmentId, filename}]'],
        // hasAttachment / attachments[]: fetchGmailMessageMetadata (triggerBus.js) enriches every mail.new payload with them.
        extraFields: ['hasAttachment', 'attachments[{attachmentId, filename}]'],
        note: 'Reply with gmail_compose replyToMessageId: trigger.output.messageId. "Last 24 h" is NOT a filter: use schedule + gmail_search newer_than:1d.',
    },
    'gmail.label.added': {
        filters: ['labelId (required)', 'from', 'subjectContains'],
        fields: ['messageId', 'addedLabelIds', 'from', 'subject'],
    },
    'google-calendar.event.upcoming': {
        filters: ['leadMinutes (default 15)', 'calendarId'],
        fields: ['eventId', 'summary', 'start', 'end', 'attendees', 'minutesUntilStart'],
    },
    'google-calendar.event.changed': {
        filters: ['calendarId', 'statusEquals'],
        fields: ['eventId', 'summary', 'start', 'end', 'status', 'attendees'],
    },
    'google-drive.file.new': {
        filters: ['folderId', 'mimeType', 'nameContains'],
        fields: ['fileId', 'name', 'mimeType', 'webViewLink'],
    },
    'nextcloud.file.new': { group: 'nc-file', filters: ['inFolder', 'extension', 'nameContains'], fields: ['path', 'name', 'extension', 'actor'], note: 'bind path, never an id (file.deleted has none).' },
    'nextcloud.file.changed': { group: 'nc-file' },
    'nextcloud.file.deleted': { group: 'nc-file' },
    'nextcloud.file.renamed': { group: 'nc-file' },
    'nextcloud.file.tagged': {
        filters: ['tagId (numeric, from nextcloud_list_tags)'],
        fields: ['fileId', 'tagId'],
        // nextcloud_read_file takes a path, and this payload has none (ids
        // only) — the full schema's "read it by fileId" advice was wrong.
        note: 'ids only — no path, no tag name.',
    },
    'nextcloud.forms.submitted': {
        filters: ['formId'],
        fields: ['formId', 'submissionId'],
        note: 'the answers are NOT in the payload: follow with nextcloud_forms_get_submissions.',
    },
    'nextcloud.tables.row.added': { group: 'nc-tables', filters: ['tableId', 'columnId + valueEquals', 'changedOnly'], fields: ['tableId', 'rowId', 'values (keyed by numeric column id)'] },
    'nextcloud.tables.row.updated': { group: 'nc-tables' },
    'nextcloud.calendar.event.upcoming': {
        filters: ['leadMinutes', 'calendarId', 'summaryContains'],
        fields: ['uid', 'summary', 'startsAt', 'endsAt', 'attendees'],
    },
    'nextcloud.calendar.event.created': {
        group: 'nc-cal',
        filters: ['calendarId'],
        fields: ['uid', 'calendarUri'],
        // calendarUri: automationEventsWebhook.js normalisePayload sets it on every calendar.* envelope.
        extraFields: ['calendarUri'],
        note: 'metadata only, no summary — read it with nextcloud_calendar_get_event (calendar: trigger.output.calendarUri, uid: trigger.output.uid).',
    },
    'nextcloud.calendar.event.changed': { group: 'nc-cal' },
    'nextcloud.talk.message.received': {
        filters: ['roomToken', 'messageContains', 'excludeOwnMessages'],
        fields: ['messageId', 'roomToken', 'actor', 'message'],
        note: 'the Bee Flow bot must be in the room; say so.',
    },
    'nextcloud.talk.reaction.added': {
        filters: ['roomToken', 'reaction'],
        fields: ['messageId', 'roomToken', 'actor', 'reaction'],
        note: 'an EVENT, not an approval gate (use builder_add_approval for that); the bot must be in the room.',
    },
    'nextcloud.deck.card.created': {
        group: 'nc-deck', filters: ['boardId', 'stackId', 'titleContains'], fields: ['cardId', 'boardId', 'stackId', 'title', 'done'],
        // fromStackId/toStackId are read by the deck.card.moved matcher against
        // payload.previousStackId / payload.stackId (filters.js, fixed 2026-09-17).
        note: 'deck.card.moved also filters fromStackId / toStackId (the list it left / landed in) and carries previousStackId.',
    },
    'nextcloud.deck.card.changed': { group: 'nc-deck' },
    'nextcloud.deck.card.deleted': { group: 'nc-deck' },
    'nextcloud.deck.card.moved': { group: 'nc-deck' },
    'nextcloud.deck.card.completed': { group: 'nc-deck' },
    'nextcloud.share.received': { filters: ['actorEquals', 'nameContains'], fields: ['path', 'name', 'actor'] },
    'nextcloud.activity.new': { filters: ['type', 'actorEquals'], fields: ['type', 'subject', 'objectName', 'actor'] },
    'nextcloud.notification.new': { filters: ['app', 'subjectContains'], fields: ['app', 'subject', 'message'] },
    'meeting-notes.meeting.processed': {
        filters: ['tags (empty = EVERY meeting)', 'reprocessed'],
        fields: ['transcriptionId', 'tags'],
        note: 'no step reads the note; pass the id on.',
    },
    'support.ticket.resolved': {
        filters: ['inboxId', 'categoryEquals', 'priorityEquals', 'tagIncludes'],
        fields: ['threadId', 'subject', 'category', 'priority', 'tags', 'transcript'],
    },
    'approvals.approval.decided': {
        filters: ['decision (approved | rejected | expired | cancelled)'],
        fields: ['approvalId', 'decision', 'reason', 'answers', 'prompt', 'decidedBy'],
    },
    'approvals.approval.requested': { filters: [], fields: ['approvalId', 'prompt', 'requestedBy', 'expiresAt'] },
    'msgraph.mail.new': {
        group: 'msgraph', filters: [], fields: ['resourceData.id'],
        // resourceData.id: the Graph change-notification envelope always names the changed item there.
        extraFields: ['resourceData.id'],
        note: 'a Graph notification, no body — read the item with the matching Outlook/OneDrive tool.',
    },
    'msgraph.mail.flagged': { group: 'msgraph' },
    'msgraph.event.created': { group: 'msgraph' },
    'msgraph.event.changed': { group: 'msgraph' },
    'msgraph.file.new': { group: 'msgraph' },
    'msgraph.file.changed': { group: 'msgraph' },
    'google-sheets.spreadsheet.changed': { group: 'gsheets', filters: [], fields: ['id', 'name', 'url', 'modifiedTime'] },
    'google-sheets.spreadsheet.new': { group: 'gsheets' },
    'google-slides.presentation.changed': { group: 'gslides', filters: [], fields: ['id', 'name', 'url', 'modifiedTime'] },
    'google-slides.presentation.new': { group: 'gslides' },
    'google-contacts.contact.new': { group: 'gcontacts', filters: [], fields: ['resourceName', 'displayName', 'email', 'phone', 'company'] },
    'google-contacts.contact.changed': { group: 'gcontacts' },
    'google-keep.note.new': { group: 'gkeep', filters: [], fields: ['noteId', 'title', 'content'] },
    'google-keep.note.changed': { group: 'gkeep' },
    'tuya.device.status.changed': { group: 'tuya', filters: [], fields: ['deviceId', 'deviceName', 'online', 'status', 'changedKeys'] },
    'tuya.device.online.changed': { group: 'tuya' },
});

// The wording for the generic matcher: exact equality on a payload field.
const GENERIC_FILTER_TEXT = 'a payload field = exact value';

/** Does this (provider, event) fall back to the shallow exact-match matcher? */
function usesGenericMatcher(provider, event) {
    return pickMatcher(provider, event) === matchFilter;
}

/** The declared, non-hidden events per non-hidden provider, registry order. */
function declaredEvents() {
    const out = [];
    for (const src of listTriggerSources({ includeHidden: false })) {
        for (const ev of (src.events || [])) {
            if (!ev || !ev.id || ev.hidden) continue;
            out.push({ provider: src.id, event: ev.id, fields: Array.isArray(ev.fields) ? ev.fields : [] });
        }
    }
    return out;
}

/** The filter bracket for one line. */
function renderFilters(provider, event, note) {
    const keys = note && Array.isArray(note.filters) ? note.filters : null;
    if (keys && keys.length) return ` [${keys.join(', ')}]`;
    if (usesGenericMatcher(provider, event)) return ` [${GENERIC_FILTER_TEXT}]`;
    // A custom matcher this file has no verified notes for: say nothing
    // rather than guess a key.
    return '';
}

/** The payload arrow for one line: the sidecar's subset, else the declaration. */
function renderFields(decl, note) {
    const fields = note && Array.isArray(note.fields) && note.fields.length ? note.fields : decl.fields.slice(0, 8);
    return fields.length ? ` → ${fields.join(', ')}` : '';
}

let memo = null;

/**
 * The `## Triggers` block. Pure function of the global registry and the
 * sidecar; memoised so every session renders the same bytes at no cost.
 * @returns {string}
 */
function renderTriggerBlockLean() {
    if (memo !== null) return memo;
    const never = [];
    const lines = [];
    // Group consecutive events that share a sidecar `group` onto one line —
    // the first member carries the filters/fields/note for all of them.
    let open = null;
    const flush = () => {
        if (!open) return;
        const head = open.events.join(' / ');
        lines.push(`- ${open.provider}: ${head}${open.filters}${open.fields}${open.note ? ` — ${open.note}` : ''}`);
        open = null;
    };
    for (const decl of declaredEvents()) {
        const key = `${decl.provider}.${decl.event}`;
        if (PUSH_PENDING[decl.provider] && PUSH_PENDING[decl.provider].has(decl.event)) {
            // Declared, listed in the UI with its deliverability note, and
            // produced by nothing: the one event the model must be told NOT
            // to propose (the recorded builds proposed it twice).
            never.push(`${decl.provider} ${decl.event}`);
            continue;
        }
        const note = TRIGGER_PROMPT_NOTES[key];
        const group = note && note.group ? note.group : null;
        if (group && open && open.group === group && open.provider === decl.provider) {
            open.events.push(decl.event);
            continue;
        }
        flush();
        const lead = group ? TRIGGER_PROMPT_NOTES[Object.keys(TRIGGER_PROMPT_NOTES).find(k => TRIGGER_PROMPT_NOTES[k].group === group)] : note;
        open = {
            provider: decl.provider,
            group,
            events: [decl.event],
            filters: renderFilters(decl.provider, decl.event, lead),
            fields: renderFields(decl, lead),
            note: lead && lead.note ? lead.note : '',
        };
        if (!group) flush();
    }
    flush();
    memo = [
        '## Triggers (builder_propose_trigger — the first call of a new draft)',
        '',
        'kind: manual | schedule {cron:"0 9 * * 1-5", tz} | form {form:{title, fields:[{name,type,label,required}]}} → trigger.output.<name> | webhook → trigger.output = the POSTed JSON | app_event {appProvider, appEvent, filter} | agent_call {toolName, description, params:[{name,type,required,description}]} | app_trigger {params:[{name,type,required}]}.',
        'An agent_call or app_trigger argument arrives as trigger.output.<name> (there is no trigger.payload): declare every argument the steps need, with a description the agent can read. After building an agent_call automation, tell the user to link it to an agent under "Who can call this" in the trigger panel: you cannot do that yourself.',
        'App events, as `appProvider: appEvent [filter keys] → payload fields` (bind them as trigger.output.<field>; an omitted filter = every event):',
        ...lines,
        ...(never.length ? [`NEVER propose ${never.join(', ')} (nothing produces it).`] : []),
    ].join('\n');
    return memo;
}

module.exports = {
    renderTriggerBlockLean,
    TRIGGER_PROMPT_NOTES,
    GENERIC_FILTER_TEXT,
    // Test seams.
    _declaredEvents: declaredEvents,
    _usesGenericMatcher: usesGenericMatcher,
};
