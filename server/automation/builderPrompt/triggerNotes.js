// @typecheck strict
/**
 * The trigger sidecar: what the declarations under triggerSources/declared/
 * do not carry — the filter keys each event's matcher reads and the cautions
 * the model needs beside an event — for the two renders in triggerBlock.js
 * (the lean `## Triggers` block and the per-user "App events you may use"
 * lines). Data only, so the renderers stay small; triggerBlock.test.js checks
 * every entry against the declarations and the matcher sources.
 */

'use strict';

/**
 * Sidecar notes keyed `provider.event`.
 *   filters      the keys the matcher / poller reads (verified by
 *                triggerBlock.test.js against triggerBus/filters*.js, the
 *                fan-out in triggerBus/dispatch.js and the pollers);
 *                a parenthesis after a key is prose the model needs beside it,
 *                and `a + b` names two keys that only work together
 *   fields       the payload fields worth naming (a subset of the declared
 *                list, plus `extraFields` for enriched keys the declaration
 *                omits but the producer always sets)
 *   extraFields  enriched payload keys, each with where it was verified
 *   group        events sharing one line (same filters, same payload)
 *   note         one caution, only where the recorded builds needed it
 *   more         extra verified filter keys the FULL band's per-user lines
 *                name (renderAppEventProviderLines); the lean system block
 *                keeps to `filters`
 *   fullNote     a longer caution, FULL band only, after `note`
 */
/** @type {Readonly<Record<string, TriggerNote>>} */
const TRIGGER_PROMPT_NOTES = Object.freeze({
    'gmail.mail.new': {
        filters: ['from', 'to', 'subjectContains', 'labelIds', 'hasAttachment', 'excludeFromSelf'],
        fields: ['messageId', 'threadId', 'from', 'to', 'subject', 'snippet', 'date', 'labelIds', 'hasAttachment', 'attachments[{attachmentId, filename}]'],
        // hasAttachment / attachments[]: fetchGmailMessageMetadata (triggerBus.js) enriches every mail.new payload with them.
        extraFields: ['hasAttachment', 'attachments[{attachmentId, filename}]'],
        more: ['cc', 'subjectRegex', 'excludeLabelIds', 'maxAgeMinutes'],
        note: 'Reply with gmail_compose replyToMessageId: trigger.output.messageId. "Last 24 h" is NOT a filter: use schedule + gmail_search newer_than:1d.',
        fullNote: 'Without replyToMessageId the reply arrives as a fresh email, even with threadId.',
    },
    'gmail.label.added': {
        filters: ['labelId (required)', 'from', 'subjectContains'],
        more: ['excludeLabelIds'],
        fields: ['messageId', 'addedLabelIds', 'from', 'subject'],
    },
    'google-calendar.event.upcoming': {
        filters: ['leadMinutes (default 15)', 'calendarId'],
        more: ['includeAllDay (default false)', 'attendeeEmailContains'],
        fields: ['eventId', 'summary', 'start', 'end', 'attendees', 'minutesUntilStart'],
    },
    'google-calendar.event.changed': {
        filters: ['calendarId', 'statusEquals'],
        more: ['attendeeEmailContains'],
        fields: ['eventId', 'summary', 'start', 'end', 'status', 'attendees'],
    },
    'google-drive.file.new': {
        filters: ['folderId', 'mimeType', 'nameContains'],
        more: ['excludeOwnUploads'],
        fields: ['fileId', 'name', 'mimeType', 'webViewLink'],
    },
    'nextcloud.file.new': { group: 'nc-file', filters: ['inFolder', 'extension', 'nameContains'], more: ['excludeOwnUploads'], fields: ['path', 'name', 'extension', 'actor'], note: 'bind path, never an id (file.deleted has none).', fullNote: 'Paths are user-relative ("/Documents/x.pdf"); file.renamed also carries oldPath.' },
    'nextcloud.file.changed': { group: 'nc-file' },
    'nextcloud.file.deleted': { group: 'nc-file' },
    'nextcloud.file.renamed': { group: 'nc-file' },
    'nextcloud.file.tagged': {
        filters: ['tagId (the numeric id from nextcloud_list_tags, or the tag name)'],
        fields: ['fileId', 'tagId'],
        // nextcloud_read_file takes a path, and this payload has none (ids
        // only) — the full schema's "read it by fileId" advice was wrong.
        note: 'the payload has ids only — no path, no tag name.',
        fullNote: 'To reach the file, call nextcloud_find_files_by_tag with trigger.output.tagId and take the item whose id equals trigger.output.fileId (it carries the path); nextcloud_direct_link takes trigger.output.fileId.',
    },
    'nextcloud.forms.submitted': {
        filters: ['formId', 'includeColleagues (true = also others\' submissions; off = only the owner\'s own)'],
        more: ['formHash', 'titleContains', 'submittedByEquals'],
        fields: ['formId', 'submissionId'],
        note: 'the answers are NOT in the payload: follow with nextcloud_forms_get_submissions.',
        fullNote: 'Bind it to trigger.output.formId and trigger.output.submissionId; it returns the answers keyed by question text (steps.<id>.output.submissions[0].answers.<Question>).',
    },
    'nextcloud.tables.row.added': {
        group: 'nc-tables',
        filters: ['tableId', 'columnId + valueEquals', 'changedOnly', 'includeColleagues (true = also others\' edits)'],
        more: ['valueContains', 'actorEquals'],
        note: 'without columnId, valueEquals / valueContains / changedOnly hold when ANY column satisfies them.',
        fullNote: 'columnId is NUMERIC and the payload values are keyed by numeric column id (get the ids from nextcloud_tables_list_columns); the nextcloud_tables_* action tools take column titles instead. changedOnly is for tables.row.updated, which also carries previousValues.',
        fields: ['tableId', 'rowId', 'values (keyed by numeric column id)'],
    },
    'nextcloud.tables.row.updated': { group: 'nc-tables' },
    'nextcloud.calendar.event.upcoming': {
        filters: ['leadMinutes', 'calendarId (omit = every calendar)', 'summaryContains'],
        fields: ['uid', 'summary', 'startsAt', 'endsAt', 'attendees'],
    },
    'nextcloud.calendar.event.created': {
        group: 'nc-cal',
        filters: ['calendarId', 'includeColleagues (true = also others\' changes in calendars the owner can see)'],
        fields: ['uid', 'calendarUri'],
        // calendarUri: automationEventsWebhook.js normalisePayload sets it on every calendar.* envelope.
        extraFields: ['calendarUri'],
        note: 'metadata only, no summary — read it with nextcloud_calendar_get_event (calendar: trigger.output.calendarUri, uid: trigger.output.uid).',
    },
    'nextcloud.calendar.event.changed': { group: 'nc-cal' },
    'nextcloud.talk.message.received': {
        filters: ['roomToken', 'messageContains', 'excludeOwnMessages', 'includeColleagues (true = also other members\' messages; off = only the owner\'s own)'],
        more: ['roomNameContains', 'actorEquals'],
        fields: ['messageId', 'roomToken', 'actor', 'message'],
        note: 'the Bee Flow bot must be in the room; say so.',
    },
    'nextcloud.talk.reaction.added': {
        filters: ['roomToken', 'reaction'],
        more: ['roomNameContains', 'actorEquals', 'includeRemoved (default false: un-reacting does not fire)'],
        fields: ['messageId', 'roomToken', 'actor', 'reaction'],
        note: 'an EVENT, not an approval gate (use builder_add_approval for that); the bot must be in the room.',
    },
    'nextcloud.deck.card.created': {
        group: 'nc-deck', filters: ['boardId', 'stackId', 'titleContains', 'includeColleagues (true = also others\' changes on boards the owner can open)'], fields: ['cardId', 'boardId', 'stackId', 'title', 'done'],
        // fromStackId/toStackId are read by the deck.card.moved matcher against
        // payload.previousStackId / payload.stackId (filters.js, fixed 2026-09-17).
        note: 'deck.card.moved also filters fromStackId / toStackId (the list it left / landed in) and carries previousStackId.',
        fullNote: '"done" is a completion timestamp or null. deck.card.moved / deck.card.completed are derived from the last state the connector saw, so they do not fire on the very first change after a connector restart: say so when one missed transition matters.',
    },
    'nextcloud.deck.card.changed': { group: 'nc-deck' },
    'nextcloud.deck.card.deleted': { group: 'nc-deck' },
    'nextcloud.deck.card.moved': { group: 'nc-deck' },
    'nextcloud.deck.card.completed': { group: 'nc-deck' },
    'nextcloud.share.received': { filters: ['actorEquals', 'nameContains'], more: ['kindEquals ("file" | "folder")'], fields: ['path', 'name', 'actor'] },
    'nextcloud.activity.new': { filters: ['type', 'actorEquals'], more: ['objectNameContains'], fields: ['type', 'subject', 'objectName', 'actor'] },
    'nextcloud.notification.new': { filters: ['app', 'subjectContains'], fields: ['app', 'subject', 'message'] },
    'meeting-notes.meeting.processed': {
        filters: ['tags (empty = EVERY meeting)', 'reprocessed'],
        fields: ['transcriptionId', 'tags'],
        note: 'no step reads the note; pass the id on.',
        fullNote: 'Tags are an ANY-of, exact and case-sensitive; leaving tags out means EVERY FINISHED MEETING, so pass only tags the user named. The payload carries no summary, title or attendees, and there is NO STEP THAT READS A NOTE BY ID (no action takes a transcriptionId): build the rule on which meeting finished, pass trigger.output.transcriptionId on as a reference and let the person open the note in Bee Flow.',
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
        // mailbox: read by matchMsGraphMailFilter and the poller (triggerBus/pollers/msGraphMail.mts).
        filters: ['mailbox (a shared mailbox address; omit = the user\'s own inbox)'],
        fields: ['resourceData.id', 'mailbox'],
        // resourceData.id: the Graph change-notification envelope always names the changed item there.
        // mailbox: set by the webhook route ("me") and the poller (the address).
        extraFields: ['resourceData.id', 'mailbox'],
        note: 'a Graph notification, no body — read it with outlook_read {messageId: trigger.output.resourceData.id, mailbox: trigger.output.mailbox}; pass the same mailbox to every Outlook step that answers it.',
        fullNote: 'A shared mailbox needs Full Access for the user and the .Shared scopes on the Microsoft connection; it is checked about once a minute. A reply or send with that mailbox goes out FROM the shared mailbox.',
    },
    'msgraph.mail.flagged': {
        group: 'msgraph', filters: [], fields: ['resourceData.id'],
        extraFields: ['resourceData.id'],
        note: 'a Graph notification, no body — read the item with the matching Outlook/OneDrive tool.',
    },
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

/**
 * Provider-wide cautions for the FULL band (renderAppEventProviderLines),
 * keyed by provider id: the delivery facts that hold for every event of the
 * provider, which the per-event lines cannot say once each.
 */
/** @type {Readonly<Record<string, string>>} */
const PROVIDER_PROMPT_NOTES = Object.freeze({
    nextcloud: [
        'Delivery: Files, system tags, Calendar, Forms, Tables and Deck are pushed by the Bee Flow connector within seconds (webhook); file.new / file.changed, share.received, activity.new, notification.new and calendar.event.upcoming are read on a ~60 s poll and need no connector; Talk events come from the Bee Flow bot, which only sees conversations a moderator added it to.',
        'Whose events: a pushed event reaches the automations of the person who caused it; filter.includeColleagues:true also reacts to colleagues\' events, and only fires when the automation\'s owner can see the resource. file.tagged stays with the person who caused it; file.new / file.changed read the owner\'s activity feed and need no switch.',
        'Nextcloud cannot tell us that something was shared (share.created has no producer): for "when a file is shared" offer a schedule + nextcloud_list_shares instead.',
    ].join(' '),
});

module.exports = { TRIGGER_PROMPT_NOTES, PROVIDER_PROMPT_NOTES };

/** @typedef {{ group?: string, filters?: string[], more?: string[], fields?: string[], extraFields?: string[], note?: string, fullNote?: string }} TriggerNote */
