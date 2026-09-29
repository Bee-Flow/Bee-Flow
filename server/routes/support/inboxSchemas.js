'use strict';
/**
 * What the tenant support inbox accepts (routes/supportInbox.js).
 *
 * Every body and query is closed. The ticket, tag and canned-reply shapes
 * are the company inbox's own (routes/support/*), so both desks refuse the
 * same things in the same words. What these close on the tenant side:
 *
 *   - PATCH /inboxes/:id handed the WHOLE body to the store, so a caller
 *     with support_inbox could rewrite server-owned columns the settings
 *     screen never sends: `email_address` (set by the mailbox OAuth),
 *     `provider_config` and `known_good_senders` (the senders that skip the
 *     non-support filter). Only the settings the screens edit are taken now.
 *   - PUT /inboxes/:id/access read `sharedGroups || []`, so a misspelled key
 *     (`sharedGroup`) opened a group-restricted inbox to the WHOLE
 *     organisation — `[]` means everyone.
 *   - `enabled: "false"` on the KB automation switched it ON (`!!"false"`).
 *   - `markNotSupport: "true"` / `unfilter: "true"` did nothing under a 200.
 *   - `limit=abc` on the ticket list reached the store as NaN.
 */

const { z, worded, bodyOf, queryOf, orEmpty, choice, wholeNumber } = require('../../core/http/schemaParts');
const { STATUSES, PATCH_THREAD_SHAPE } = require('./threads');
const { TagBody } = require('./tags');
const { CreateCanned, UpdateCanned } = require('./cannedResponses');

const text = (message, max) => worded(message).max(max, message);
const bool = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` });
const fraction = (name) => z.number({ invalid_type_error: `${name} is a number from 0 to 1.` })
    .min(0, `${name} is a number from 0 to 1.`).max(1, `${name} is a number from 0 to 1.`);
const ids = (name) => z.array(text(`${name} is a list of ids.`, 200), { invalid_type_error: `${name} is a list of ids.` }).max(200, `${name} holds at most 200 ids.`);
const REPLY_MODES = ['draft', 'auto_confident', 'autonomous'];
const replyMode = (name) => choice(REPLY_MODES, `${name} is one of: ${REPLY_MODES.join(', ')}.`);
const folders = (name) => z.array(text(`${name} is a list of folder names.`, 200), { invalid_type_error: `${name} is a list of folder names.` }).max(50, `${name} holds at most 50 folders.`);

const CreateInboxBody = bodyOf({
    organizationId: text('organizationId is the id of your organisation.', 200).optional(),
    provider: choice(['gmail', 'outlook'], 'provider must be gmail or outlook'),
    displayName: text('displayName is text of at most 200 characters.', 200).optional(),
    defaultAgentId: text('defaultAgentId is the id of an agent.', 200).nullish(),
    kbIds: ids('kbIds').optional(),
    replyMode: replyMode('replyMode').optional(),
    autoresolveThreshold: fraction('autoresolveThreshold').optional(),
    toolsEnabled: bool('toolsEnabled').optional(),
    signature: text('signature is text of at most 10000 characters.', 10_000).nullish(),
    folderFilter: folders('folderFilter').optional(),
}, 'Creating an inbox');

// The settings the Inboxes and Replies screens edit. Server-owned columns
// (email_address, provider_config, known_good_senders, the KB automation and
// shared_groups) have their own routes and are refused here by name.
const PatchInboxBody = bodyOf({
    display_name: text('display_name is text of at most 200 characters.', 200).optional(),
    default_agent_id: text('default_agent_id is the id of an agent.', 200).nullish(),
    kb_ids: ids('kb_ids').nullish(),
    reply_mode: replyMode('reply_mode').optional(),
    autoresolve_threshold: fraction('autoresolve_threshold').optional(),
    tools_enabled: bool('tools_enabled').optional(),
    enabled_tool_ids: ids('enabled_tool_ids').optional(),
    operator_user_id: text('operator_user_id is the id of a teammate.', 200).nullish(),
    signature: text('signature is text of at most 10000 characters.', 10_000).nullish(),
    classify_non_support_enabled: bool('classify_non_support_enabled').optional(),
    classify_sensitivity: fraction('classify_sensitivity').optional(),
    classify_suppress_autoreply: bool('classify_suppress_autoreply').optional(),
    folder_filter: folders('folder_filter').optional(),
    sync_interval_minutes: wholeNumber('sync_interval_minutes is a whole number of minutes, 1 to 1440.', { min: 1, max: 1440 }).optional(),
    active: bool('active').optional(),
}, 'Inbox settings');

const KbAutomationBody = bodyOf({
    enabled: bool('enabled'),
    knowledgeBaseId: text('knowledgeBaseId is the id of a knowledge base.', 200).nullish(),
}, 'Knowledge ingestion');

const ScanBody = bodyOf({
    windowDays: wholeNumber('windowDays is a whole number of days, 1 to 730.', { min: 1, max: 730 }).optional(),
}, 'A history scan');

const SHARED_GROUPS_TEXT = 'sharedGroups is the list of group ids that may open this inbox; an empty list means everyone.';
const AccessBody = bodyOf({
    sharedGroups: z.array(text(SHARED_GROUPS_TEXT, 200), { required_error: SHARED_GROUPS_TEXT, invalid_type_error: SHARED_GROUPS_TEXT }),
}, 'Inbox access');

const STATUS_LIST_TEXT = `status is a comma-separated list of: ${STATUSES.join(', ')}.`;
const PAGE = {
    limit: wholeNumber('limit is a whole number from 1 to 500.', { min: 1, max: 500 }).optional(),
    offset: wholeNumber('offset is a whole number, 0 or more.').optional(),
};
const ThreadsQuery = queryOf({
    inbox: text('inbox is the id of an inbox.', 200).optional(),
    status: worded(STATUS_LIST_TEXT)
        .refine((v) => v.split(',').map((s) => s.trim()).filter(Boolean).every((s) => STATUSES.includes(s)), STATUS_LIST_TEXT)
        .optional(),
    q: text('A search is at most 200 characters.', 200).optional(),
    assignee: text('assignee is the id of a teammate.', 200).optional(),
    tag: text('tag is a label.', 100).optional(),
    excludeFiltered: choice(['0', '1'], 'excludeFiltered is 0 to include filtered tickets.').optional(),
    ...PAGE,
}, 'The ticket list');

const ReplyBody = bodyOf({
    body: worded('body required').max(10_000, 'A reply is at most 10000 characters.'),
    bodyHtml: text('bodyHtml is the reply as HTML.', 100_000).nullish(),
    internalNote: bool('internalNote').optional(),
}, 'A reply');

const PatchThreadBody = bodyOf({
    ...PATCH_THREAD_SHAPE,
    markNotSupport: bool('markNotSupport').optional(),
    unfilter: bool('unfilter').optional(),
}, 'A ticket update');

const InboxQuery = queryOf({ inbox: text('inbox is the id of an inbox.', 200).optional() }, 'Insights');
const OperatorQuery = queryOf({ operator: text('operator is the id of a teammate.', 200).optional() }, 'Available integrations');

const auditFilters = {
    actor: text('actor is who acted, like staff or ai.', 40).optional(),
    action: text('action is the name of an audited action.', 100).optional(),
    from: text('from is a date, like 2026-09-01T00:00:00Z.', 64).optional(),
    to: text('to is a date, like 2026-09-01T00:00:00Z.', 64).optional(),
    cursor: text('cursor is the value the previous page handed back.', 200).optional(),
    limit: PAGE.limit,
};
const InboxAuditQuery = queryOf(auditFilters, 'The inbox audit');
const AuditQuery = queryOf({ inbox: text('inbox is the id of an inbox.', 200).optional(), ...auditFilters }, 'The audit feed');

const PRIORITIES = PATCH_THREAD_SHAPE.priority.unwrap().options;
const MINUTES_TEXT = (name) => `${name} is a whole number of minutes, 1 to 525600.`;
const SlaBody = bodyOf({
    priority: choice(PRIORITIES, `priority is one of: ${PRIORITIES.join(', ')}.`),
    firstResponseMinutes: wholeNumber(MINUTES_TEXT('firstResponseMinutes'), { min: 1, max: 525_600 }),
    resolutionMinutes: wholeNumber(MINUTES_TEXT('resolutionMinutes'), { min: 1, max: 525_600 }),
    enabled: bool('enabled').optional(),
}, 'An SLA policy');

module.exports = {
    CreateInboxBody, PatchInboxBody, KbAutomationBody, ScanBody, AccessBody, ThreadsQuery, ReplyBody,
    PatchThreadBody, InboxQuery, OperatorQuery, InboxAuditQuery, AuditQuery, SlaBody,
    TagBody: orEmpty(TagBody), CreateCanned: orEmpty(CreateCanned), UpdateCanned: orEmpty(UpdateCanned),
};
