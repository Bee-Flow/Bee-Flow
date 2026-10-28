// @typecheck strict
/**
 * Output schemas of the Nextcloud GROUPWARE tools: calendar, contacts, deck,
 * forms, mail, notes and tasks.
 * Read off the handlers' success returns in integrations/nextcloud*. Same
 * contract as ./outputSchemas.js (`shape`, `sample`, `echo`); the coverage
 * test (outputSchemas.nextcloudCoverage.test.js) fails on a nextcloud_* tool
 * that has an entry in none of the schema files.
 */
'use strict';

const NOW = 1791100000; // a fixed unix time, so a sample never changes between dry runs
const EVENT = '{ uid, summary, description, location, attendees: [{ cn, email }], dtstart, dtend, organizer, allDay, talkToken, etag, href, calendar }';
const SAMPLE_EVENT = { uid: 'evt-1@cloud.example.com', summary: 'Standup', description: null, location: null, attendees: [{ cn: 'Bob', email: 'bob@example.com' }], dtstart: '2026-10-29T09:00:00.000Z', dtend: '2026-10-29T09:15:00.000Z', organizer: { cn: 'Alice', email: 'alice@example.com' }, allDay: false, talkToken: null };
const CONTACT = '{ uid, fullName, firstName, lastName, emails: [string], phones: [string], organization, title, notes, etag, href, addressbook }';
const SAMPLE_CONTACT = { uid: 'c-1', fullName: 'Bob Jansen', firstName: 'Bob', lastName: 'Jansen', emails: ['bob@example.com'], phones: ['+31 20 000 0000'], organization: 'Example BV', title: 'Buyer', notes: null };
const DECK_LABEL = { id: 1, title: 'Urgent', color: 'ff0000' };
const DECK_CARD = '{ id, stackId, stackTitle, title, description, duedate, labels: [{ id, title, color }], assignedUsers: [uid], archived, order, type }';
const SAMPLE_DECK_CARD = { id: 4521, stackId: 5, stackTitle: 'Inbox', title: 'Call supplier', description: '', duedate: null, labels: [DECK_LABEL], assignedUsers: ['alice'], archived: false, order: 0, type: 'plain' };
const RAW_DECK_CARD = '{ id, title, description, stackId, type, order, archived, duedate, labels, assignedUsers, owner, createdAt, lastModified }';
const SAMPLE_RAW_DECK_CARD = { id: 4521, title: 'Call supplier', description: '', stackId: 5, type: 'plain', order: 0, archived: false, duedate: null, labels: [], assignedUsers: [], owner: 'alice', createdAt: NOW, lastModified: NOW };
const DECK_COMMENT = '{ id, objectId, message, actorId, actorType, actorDisplayName, creationDateTime, mentions }';
const SAMPLE_DECK_COMMENT = { id: 77, objectId: 4521, message: 'Done, see the attached file.', actorId: 'alice', actorType: 'users', actorDisplayName: 'Alice', creationDateTime: '2026-10-28T10:00:00+00:00', mentions: [] };
const FORM = '{ id, hash, title, description, ownerId, created, expires, isAnonymous, submitMultiple, state, submissionCount }';
const SAMPLE_FORM = { id: 12, hash: 'aB3dE5fG7hJ9kL1m', title: 'Intake', description: '', ownerId: 'alice', created: NOW, expires: null, isAnonymous: false, submitMultiple: false, state: 0, submissionCount: 3 };
const QUESTION = '{ id, text, type, isRequired, description, options: [{ id, text }] }';
const MAIL_SUMMARY = '{ id (the database id the other Mail tools take), messageIdHeader, threadRootId, from, to, subject, dateInt, preview, hasAttachments, flags, mailboxId }';
const SAMPLE_MAIL = { id: 1201, messageIdHeader: '<abc@example.com>', threadRootId: '<abc@example.com>', from: 'bob@example.com', to: 'alice@example.com', subject: 'Invoice October', dateInt: NOW, preview: 'Please find attached…', hasAttachments: true, flags: { seen: false, flagged: false }, mailboxId: 3 };
const NOTE = '{ id, title, category, modified, favorite, excerpt (first 200 characters, when the content was fetched) }';
const SAMPLE_NOTE = { id: 301, title: 'Meeting notes', category: 'Work', modified: NOW, favorite: false, excerpt: 'Agreed: send the offer before Friday.' };
const TASK = '{ uid, summary, description, due, priority, status (NEEDS-ACTION|IN-PROCESS|COMPLETED|CANCELLED), percentComplete, completed, categories: [string], etag, href, list }';
const SAMPLE_TASK = { uid: 'task-1@cloud.example.com', summary: 'Send the offer', description: null, due: '2026-10-31T16:00:00.000Z', priority: 0, status: 'NEEDS-ACTION', percentComplete: 0, completed: null, categories: [], list: 'tasks' };

/** @type {Record<string, import('./outputSchemas').OutputSchema>} */
const OUTPUT_SCHEMAS_NEXTCLOUD_GROUPWARE = {
    // ── Calendar ──────────────────────────────────────────────────
    nextcloud_calendar_list: {
        shape: { count: 'integer', calendars: 'array of { slug (the calendar id other tools take), displayName, href, writable }' },
        sample: { count: 1, calendars: [{ slug: 'personal', displayName: 'Personal', href: '/remote.php/dav/calendars/alice/personal/', writable: true }] },
    },
    nextcloud_calendar_search_events: {
        shape: { query: 'string', count: 'integer', events: `array of ${EVENT}` },
        sample: { query: 'standup', count: 1, events: [{ ...SAMPLE_EVENT, etag: '"e1"', href: '/remote.php/dav/calendars/alice/personal/evt-1.ics', calendar: 'personal' }] },
        echo: { query: 'query' },
    },
    nextcloud_calendar_get_event: {
        // FLAT: the event's own fields at the top, no `event` wrapper. Times are
        // `dtstart` / `dtend` (create and update take `start` / `end`).
        shape: { uid: 'string', summary: 'string|null', description: 'string|null', location: 'string|null', attendees: 'array of { cn, email }', dtstart: 'string (ISO)', dtend: 'string (ISO)', organizer: 'object { cn, email }|null', allDay: 'boolean', talkToken: 'string|null', etag: 'string', calendar: 'string' },
        sample: { ...SAMPLE_EVENT, etag: '"e1"', calendar: 'personal' },
        echo: { uid: 'uid', calendar: 'calendar' },
    },
    nextcloud_calendar_update_event: {
        shape: { success: 'boolean', calendar: 'string', uid: 'string', etag: 'string|null' },
        sample: { success: true, calendar: 'personal', uid: 'evt-1@cloud.example.com', etag: '"e2"' },
        echo: { calendar: 'calendar', uid: 'uid' },
    },
    nextcloud_calendar_delete_event: {
        shape: { success: 'boolean', calendar: 'string', uid: 'string' },
        sample: { success: true, calendar: 'personal', uid: 'evt-1@cloud.example.com' },
        echo: { calendar: 'calendar', uid: 'uid' },
    },

    // ── Contacts ──────────────────────────────────────────────────
    nextcloud_contacts_list_addressbooks: {
        shape: { count: 'integer', addressbooks: 'array of { slug, displayName, href }' },
        sample: { count: 1, addressbooks: [{ slug: 'contacts', displayName: 'Contacts', href: '/remote.php/dav/addressbooks/users/alice/contacts/' }] },
    },
    nextcloud_contacts_list: {
        shape: { addressbook: 'string', count: 'integer', contacts: `array of ${CONTACT}` },
        sample: { addressbook: 'contacts', count: 1, contacts: [{ ...SAMPLE_CONTACT, etag: '"c1"', href: '/remote.php/dav/addressbooks/users/alice/contacts/c-1.vcf', addressbook: 'contacts' }] },
        echo: { addressbook: 'addressbook' },
    },
    nextcloud_contacts_search: {
        shape: { query: 'string', count: 'integer', contacts: `array of ${CONTACT}` },
        sample: { query: 'jansen', count: 1, contacts: [{ ...SAMPLE_CONTACT, etag: '"c1"', href: '/remote.php/dav/addressbooks/users/alice/contacts/c-1.vcf', addressbook: 'contacts' }] },
        echo: { query: 'query' },
    },
    nextcloud_contacts_get: {
        // FLAT: the contact's fields at the top.
        shape: { uid: 'string', fullName: 'string|null', firstName: 'string|null', lastName: 'string|null', emails: 'array of string', phones: 'array of string', organization: 'string|null', title: 'string|null', notes: 'string|null', etag: 'string', addressbook: 'string' },
        sample: { ...SAMPLE_CONTACT, etag: '"c1"', addressbook: 'contacts' },
        echo: { uid: 'uid', addressbook: 'addressbook' },
    },
    nextcloud_contacts_create: {
        shape: { success: 'boolean', addressbook: 'string', uid: 'string', etag: 'string|null' },
        sample: { success: true, addressbook: 'contacts', uid: 'c-2', etag: '"c2"' },
        echo: { addressbook: 'addressbook' },
    },
    nextcloud_contacts_update: {
        shape: { success: 'boolean', addressbook: 'string', uid: 'string', etag: 'string|null' },
        sample: { success: true, addressbook: 'contacts', uid: 'c-1', etag: '"c3"' },
        echo: { addressbook: 'addressbook', uid: 'uid' },
    },
    nextcloud_contacts_delete: {
        shape: { success: 'boolean', addressbook: 'string', uid: 'string' },
        sample: { success: true, addressbook: 'contacts', uid: 'c-1' },
        echo: { addressbook: 'addressbook', uid: 'uid' },
    },

    // ── Deck ──────────────────────────────────────────────────────
    nextcloud_deck_get_board: {
        // The raw Deck board. Its columns are NOT in it: nextcloud_deck_list_stacks.
        shape: { id: 'integer', title: 'string', color: 'string', archived: 'boolean', owner: 'object { uid, displayname }', labels: 'array of { id, title, color }', acl: 'array', permissions: 'object { PERMISSION_READ, PERMISSION_EDIT, PERMISSION_MANAGE, PERMISSION_SHARE }', users: 'array', lastModified: 'integer' },
        sample: { id: 2, title: 'Demo Ops', color: '0082c9', archived: false, owner: { uid: 'alice', displayname: 'Alice' }, labels: [DECK_LABEL], acl: [], permissions: { PERMISSION_READ: true, PERMISSION_EDIT: true, PERMISSION_MANAGE: true, PERMISSION_SHARE: true }, users: [], lastModified: NOW },
        echo: { id: 'boardId' },
    },
    nextcloud_deck_create_stack: {
        shape: { success: 'boolean', stack: 'object { id, title, order, boardId }' },
        sample: { success: true, stack: { id: 9, title: 'Review', order: 999, boardId: 2 } },
        echo: { 'stack.title': 'title', 'stack.boardId': 'boardId' },
    },
    nextcloud_deck_update_stack: {
        shape: { success: 'boolean', stack: 'object { id, title, order }' },
        sample: { success: true, stack: { id: 9, title: 'Review', order: 1 } },
        echo: { 'stack.id': 'stackId', 'stack.title': 'title' },
    },
    nextcloud_deck_delete_stack: {
        shape: { success: 'boolean', stackId: 'integer' },
        sample: { success: true, stackId: 9 },
        echo: { stackId: 'stackId' },
    },
    nextcloud_deck_list_cards: {
        shape: { boardId: 'integer', count: 'integer', cards: `array of ${DECK_CARD}` },
        sample: { boardId: 2, count: 1, cards: [SAMPLE_DECK_CARD] },
        echo: { boardId: 'boardId' },
    },
    nextcloud_deck_search_cards: {
        shape: { boardId: 'integer', count: 'integer', cards: `array of ${DECK_CARD}` },
        sample: { boardId: 2, count: 1, cards: [SAMPLE_DECK_CARD] },
        echo: { boardId: 'boardId' },
    },
    nextcloud_deck_get_card: {
        // The raw Deck card.
        shape: { id: 'integer', title: 'string', description: 'string', stackId: 'integer', type: 'string', order: 'integer', archived: 'boolean', duedate: 'string|null', labels: 'array of { id, title, color }', assignedUsers: 'array of { participant: { uid, displayname } }', owner: 'string|object', createdAt: 'integer', lastModified: 'integer' },
        sample: SAMPLE_RAW_DECK_CARD,
        echo: { id: 'cardId', stackId: 'stackId' },
    },
    nextcloud_deck_update_card: {
        // { success, card }. When a requested move could not be verified:
        // { success, updated, moveError } (the card is under `updated`).
        shape: { success: 'boolean', card: `object ${RAW_DECK_CARD}`, updated: 'object|undefined (only with moveError)', moveError: 'string|undefined' },
        sample: { success: true, card: SAMPLE_RAW_DECK_CARD },
        echo: { 'card.id': 'cardId', 'card.title': 'title', 'card.stackId': 'targetStackId' },
    },
    nextcloud_deck_archive_card: {
        shape: { success: 'boolean', archived: 'boolean' },
        sample: { success: true, archived: true },
        echo: { archived: 'archived' },
    },
    nextcloud_deck_delete_card: {
        shape: { success: 'boolean', cardId: 'integer' },
        sample: { success: true, cardId: 4521 },
        echo: { cardId: 'cardId' },
    },
    nextcloud_deck_assign_label: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_deck_remove_label: {
        shape: { success: 'boolean' },
        sample: { success: true },
    },
    nextcloud_deck_add_comment: {
        shape: { success: 'boolean', comment: `object ${DECK_COMMENT}` },
        sample: { success: true, comment: SAMPLE_DECK_COMMENT },
        echo: { 'comment.message': 'message', 'comment.objectId': 'cardId' },
    },
    nextcloud_deck_list_comments: {
        shape: { count: 'integer', comments: `array of ${DECK_COMMENT}` },
        sample: { count: 1, comments: [SAMPLE_DECK_COMMENT] },
    },

    // ── Forms ─────────────────────────────────────────────────────
    nextcloud_forms_list: {
        shape: { count: 'integer', forms: `array of ${FORM}` },
        sample: { count: 1, forms: [SAMPLE_FORM] },
    },
    nextcloud_forms_get: {
        shape: { form: `object ${FORM}`, questions: `array of ${QUESTION}`, shareUrl: 'string|null' },
        sample: { form: SAMPLE_FORM, questions: [{ id: 31, text: 'Your name', type: 'short', isRequired: true, description: '', options: [] }], shareUrl: 'https://cloud.example.com/index.php/apps/forms/s/aB3dE5fG7hJ9kL1m' },
        echo: { 'form.id': 'formId' },
    },
    nextcloud_forms_create: {
        // The new form is under `form`: bind `form.id`, not `id`.
        shape: { success: 'boolean', form: `object ${FORM}`, shareUrl: 'string|null' },
        sample: { success: true, form: { ...SAMPLE_FORM, id: 13, submissionCount: null }, shareUrl: 'https://cloud.example.com/index.php/apps/forms/s/aB3dE5fG7hJ9kL1m' },
        echo: { 'form.title': 'title', 'form.description': 'description' },
    },
    nextcloud_forms_add_question: {
        shape: { success: 'boolean', question: `object ${QUESTION}`, options: 'array of string' },
        sample: { success: true, question: { id: 32, text: 'Which day suits you?', type: 'multiple_unique', isRequired: false, description: '', options: [{ text: 'Monday' }, { text: 'Tuesday' }] }, options: ['Monday', 'Tuesday'] },
        echo: { 'question.text': 'text', 'question.type': 'type' },
    },
    nextcloud_forms_get_submissions: {
        shape: { formId: 'integer|string', formTitle: 'string', questions: 'array of string (question texts)', count: 'integer', truncated: 'boolean', submissions: 'array of { id, formId, userId, timestamp, submittedAt, answers (keyed by question text), answersByQuestionId }' },
        sample: { formId: 12, formTitle: 'Intake', questions: ['Your name'], count: 1, truncated: false, submissions: [{ id: 501, formId: 12, userId: 'bob', timestamp: NOW, submittedAt: '2026-10-28T09:00:00.000Z', answers: { 'Your name': 'Bob' }, answersByQuestionId: { 31: 'Bob' } }] },
        echo: { formId: 'formId' },
    },
    nextcloud_forms_update_settings: {
        shape: { success: 'boolean', formId: 'integer|string', updated: 'array of string (the settings that changed)' },
        sample: { success: true, formId: 12, updated: ['title'] },
        echo: { formId: 'formId' },
    },
    nextcloud_forms_delete: {
        shape: { success: 'boolean', formId: 'integer|string' },
        sample: { success: true, formId: 12 },
        echo: { formId: 'formId' },
    },

    // ── Mail ──────────────────────────────────────────────────────
    nextcloud_mail_list_accounts: {
        shape: { count: 'integer', accounts: 'array of { id, email, displayName, provisioned }' },
        sample: { count: 1, accounts: [{ id: 1, email: 'alice@example.com', displayName: 'Alice', provisioned: false }] },
    },
    nextcloud_mail_list_mailboxes: {
        shape: { count: 'integer', mailboxes: 'array of { id, name, displayName, unreadMessages, specialRole }' },
        sample: { count: 2, mailboxes: [{ id: 3, name: 'INBOX', displayName: 'Inbox', unreadMessages: 4, specialRole: 'inbox' }, { id: 4, name: 'Archive', displayName: 'Archive', unreadMessages: 0, specialRole: 'archive' }] },
    },
    nextcloud_mail_search: {
        shape: { mailboxId: 'integer', count: 'integer', messages: `array of ${MAIL_SUMMARY}` },
        sample: { mailboxId: 3, count: 1, messages: [SAMPLE_MAIL] },
        echo: { mailboxId: 'mailboxId' },
    },
    nextcloud_mail_read: {
        shape: { id: 'integer', messageIdHeader: 'string|null', from: 'array of { label, email }', to: 'array of { label, email }', cc: 'array of { label, email }', subject: 'string', dateInt: 'integer', hasHtmlBody: 'boolean', truncated: 'boolean', body: 'string', attachments: 'array of { id, filename, mimeType, size, isInline }' },
        sample: { id: 1201, messageIdHeader: '<abc@example.com>', from: [{ label: 'Bob', email: 'bob@example.com' }], to: [{ label: 'Alice', email: 'alice@example.com' }], cc: [], subject: 'Invoice October', dateInt: NOW, hasHtmlBody: false, truncated: false, body: 'Please find the invoice attached.', attachments: [{ id: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 51200, isInline: false }] },
        echo: { id: 'messageId' },
    },
    nextcloud_mail_read_attachment: {
        shape: { messageId: 'integer', attachmentId: 'string', filename: 'string', mimeType: 'string', size: 'integer', extractedVia: 'string|undefined', truncated: 'boolean', content: 'string', meta: 'object|undefined' },
        sample: { messageId: 1201, attachmentId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 51200, extractedVia: 'pdf-text-layer', truncated: false, content: 'INVOICE\nAmount: EUR 1.240,00', meta: { pages: 1 } },
        echo: { messageId: 'messageId', attachmentId: 'attachmentId', filename: 'filename' },
    },
    nextcloud_mail_save_attachment: {
        shape: { success: 'boolean', messageId: 'integer', attachmentId: 'string', savedTo: 'string' },
        sample: { success: true, messageId: 1201, attachmentId: '2', savedTo: '/Invoices/' },
        echo: { messageId: 'messageId', attachmentId: 'attachmentId', savedTo: 'targetPath' },
    },
    nextcloud_mail_set_flags: {
        shape: { success: 'boolean', messageId: 'integer', flags: 'object (the flags that were set, e.g. { seen: true })' },
        sample: { success: true, messageId: 1201, flags: { seen: true } },
        echo: { messageId: 'messageId' },
    },
    nextcloud_mail_move: {
        shape: { success: 'boolean', messageId: 'integer', destMailboxId: 'integer' },
        sample: { success: true, messageId: 1201, destMailboxId: 4 },
        echo: { messageId: 'messageId', destMailboxId: 'destMailboxId' },
    },

    // ── Notes ─────────────────────────────────────────────────────
    nextcloud_notes_list: {
        shape: { count: 'integer', notes: `array of ${NOTE}` },
        sample: { count: 1, notes: [{ id: 301, title: 'Meeting notes', category: 'Work', modified: NOW, favorite: false }] },
    },
    nextcloud_notes_search: {
        shape: { query: 'string', count: 'integer', notes: `array of ${NOTE}` },
        sample: { query: 'offer', count: 1, notes: [SAMPLE_NOTE] },
        echo: { query: 'query' },
    },
    nextcloud_notes_get: {
        shape: { id: 'integer', title: 'string', category: 'string', modified: 'integer', favorite: 'boolean', etag: 'string', truncated: 'boolean', content: 'string' },
        sample: { id: 301, title: 'Meeting notes', category: 'Work', modified: NOW, favorite: false, etag: 'n1', truncated: false, content: 'Agreed: send the offer before Friday.' },
        echo: { id: 'id' },
    },
    nextcloud_notes_create: {
        // The new note is under `note`: bind `note.id`, not `id`.
        shape: { success: 'boolean', note: `object ${NOTE}` },
        sample: { success: true, note: SAMPLE_NOTE },
        echo: { 'note.title': 'title', 'note.category': 'category' },
    },
    nextcloud_notes_append: {
        // appended: true when the note existed; created: true when it was made.
        shape: { success: 'boolean', appended: 'boolean', created: 'boolean|undefined', note: `object ${NOTE}` },
        sample: { success: true, appended: true, note: SAMPLE_NOTE },
        echo: { 'note.title': 'title', 'note.category': 'category' },
    },
    nextcloud_notes_update: {
        shape: { success: 'boolean', note: `object ${NOTE}` },
        sample: { success: true, note: SAMPLE_NOTE },
        echo: { 'note.id': 'id', 'note.title': 'title', 'note.category': 'category' },
    },
    nextcloud_notes_delete: {
        shape: { success: 'boolean', id: 'integer' },
        sample: { success: true, id: 301 },
        echo: { id: 'id' },
    },
    nextcloud_notes_list_categories: {
        shape: { count: 'integer', categories: 'array of { category, count }' },
        sample: { count: 1, categories: [{ category: 'Work', count: 4 }] },
    },

    // ── Tasks ─────────────────────────────────────────────────────
    nextcloud_tasks_list_lists: {
        shape: { count: 'integer', lists: 'array of { slug (the list id other tools take), displayName, href, supportsTasks, writable }' },
        sample: { count: 1, lists: [{ slug: 'tasks', displayName: 'Tasks', href: '/remote.php/dav/calendars/alice/tasks/', supportsTasks: true, writable: true }] },
    },
    nextcloud_tasks_list: {
        shape: { list: 'string', count: 'integer', tasks: `array of ${TASK}` },
        sample: { list: 'tasks', count: 1, tasks: [{ ...SAMPLE_TASK, etag: '"t1"', href: '/remote.php/dav/calendars/alice/tasks/task-1.ics' }] },
        echo: { list: 'list' },
    },
    nextcloud_tasks_search: {
        shape: { query: 'string', count: 'integer', tasks: `array of ${TASK}` },
        sample: { query: 'offer', count: 1, tasks: [{ ...SAMPLE_TASK, etag: '"t1"', href: '/remote.php/dav/calendars/alice/tasks/task-1.ics' }] },
        echo: { query: 'query' },
    },
    nextcloud_tasks_get: {
        // FLAT: the task's fields at the top.
        shape: { uid: 'string', summary: 'string|null', description: 'string|null', due: 'string|null', priority: 'integer', status: 'string', percentComplete: 'integer', completed: 'string|null', categories: 'array of string', etag: 'string', list: 'string' },
        sample: { ...SAMPLE_TASK, etag: '"t1"' },
        echo: { uid: 'uid', list: 'list' },
    },
    nextcloud_tasks_create: {
        shape: { success: 'boolean', list: 'string', uid: 'string', etag: 'string|null' },
        sample: { success: true, list: 'tasks', uid: 'task-2@cloud.example.com', etag: '"t2"' },
        echo: { list: 'list' },
    },
    nextcloud_tasks_update: {
        shape: { success: 'boolean', list: 'string', uid: 'string', etag: 'string|null', status: 'string' },
        sample: { success: true, list: 'tasks', uid: 'task-1@cloud.example.com', etag: '"t3"', status: 'IN-PROCESS' },
        echo: { list: 'list', uid: 'uid' },
    },
    nextcloud_tasks_complete: {
        shape: { success: 'boolean', list: 'string', uid: 'string', etag: 'string|null', status: 'string (COMPLETED)' },
        sample: { success: true, list: 'tasks', uid: 'task-1@cloud.example.com', etag: '"t3"', status: 'COMPLETED' },
        echo: { list: 'list', uid: 'uid' },
    },
    nextcloud_tasks_delete: {
        shape: { success: 'boolean', list: 'string', uid: 'string' },
        sample: { success: true, list: 'tasks', uid: 'task-1@cloud.example.com' },
        echo: { list: 'list', uid: 'uid' },
    },
};

module.exports = { OUTPUT_SCHEMAS_NEXTCLOUD_GROUPWARE };
