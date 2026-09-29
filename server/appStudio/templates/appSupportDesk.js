/**
 * App Studio template — Support desk.
 *
 * The acceptance test for the mailbox wave: if a working shared inbox cannot be
 * authored here without inventing new capability, something upstream is wrong.
 *
 * HOW IT ACTUALLY WORKS — the part that matters:
 * the mailbox connector runs with `groupIntoThreads`, so it writes TWO tables in
 * one pass: one row per conversation into `tickets` (grain 0) and every message
 * into `messages` (grain 1, related by position). Tickets therefore appear by
 * themselves as soon as mail arrives — nothing has to create them. An upsert
 * writes only the columns the connector emits, so the columns the TEAM owns
 * (status, priority, assignee, tags) survive every re-sync untouched. That split
 * — mailbox owns the facts, team owns the judgement — is the whole design.
 *
 * PRIVACY: the shipped connector is scoped to `label:support`. A template that
 * installed itself and immediately copied the installer's entire personal inbox
 * into an app database would be a nasty surprise; this way the desk stays empty
 * until someone deliberately labels a message. Retention is 90 days and now
 * purges the messages table too, not just the ticket roll-up.
 *
 * AUTHORING CONSTRAINTS THAT SHAPED THIS FILE (they are not obvious):
 *  • A binding filter formula may only read currentUser / vars / forms / screen
 *    / today. Reading form.*, item.*, records.* or now makes the fetch-layer and
 *    read-side cache keys diverge and the component loads forever. So there are
 *    no per-row data bindings inside a repeater here.
 *  • `filter_bar` publishes to ONE hardcoded variable, `vars.filters`. One per
 *    screen, never two.
 *  • Nesting depth is capped at 5 (section=1, each container +1). The split
 *    spends two, so the composer form sits directly in the main pane.
 *  • An aggregate with no explicit `limit` is silently capped at 50 rows.
 */

'use strict';

const THEME_DEFAULTS = {
    radius: 'md',
    density: 'comfortable',
    fontScale: 'md',
    appearance: 'auto',
};

const STATUS_OPTIONS = [
    { value: 'new', label: 'New' },
    { value: 'open', label: 'Open' },
    { value: 'awaiting_user', label: 'Waiting on customer' },
    { value: 'awaiting_agent', label: 'Waiting on us' },
    { value: 'resolved', label: 'Resolved' },
];

const PRIORITY_OPTIONS = [
    { value: 'low', label: 'Low' },
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
];

/**
 * The access matrix. Every table names it explicitly; none is left on
 * `default: 'app'`.
 *
 * `'app'` resolves EVERY action to `'all'` for EVERY role — so a desk with an
 * admin role and an agent role had one role wearing two names, and any agent
 * could delete the audit trail, rewrite the saved replies or drop a customer's
 * messages. `'role'` inverts the default to deny, and each grant below is a
 * decision rather than an oversight.
 *
 * The owner is never listed: resolveScope short-circuits them to full access,
 * which is right — an audit log nobody can ever delete is its own GDPR problem.
 */
const ACCESS_TICKETS = {
    default: 'role',
    roles: {
        // Triage is the agent's job; closing the account is not. Neither role
        // creates a ticket — mail does that.
        admin: { read: 'all', create: false, update: 'all', delete: 'all' },
        agent: { read: 'all', create: false, update: 'all', delete: false },
    },
};

const ACCESS_MESSAGES = {
    default: 'role',
    roles: {
        // Read-only for both. Every message here is either ingested by the
        // connector or written by the send step acting as the owner; a message
        // an agent could edit is a customer record they could rewrite.
        admin: { read: 'all', create: false, update: false, delete: 'all' },
        agent: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_ACTIVITY = {
    default: 'role',
    // APPEND-ONLY. The point of an audit trail is that the people it records
    // cannot edit it — including the admin.
    roles: {
        admin: { read: 'all', create: true, update: false, delete: false },
        agent: { read: 'all', create: true, update: false, delete: false },
    },
};

const ACCESS_ATTACHMENTS = {
    default: 'role',
    roles: {
        admin: { read: 'all', create: false, update: false, delete: 'all' },
        agent: { read: 'all', create: false, update: false, delete: false },
    },
};

const ACCESS_DOC_LINES = {
    default: 'role',
    // create:true for the agent is LOAD-BEARING: ai_extract writes its rows as
    // the viewer, so without it "Read this invoice" answers 403 for everyone
    // except the owner. Delete is 'own' — you may clear an extraction you ran.
    roles: {
        admin: { read: 'all', create: true, update: false, delete: 'all' },
        agent: { read: 'all', create: true, update: false, delete: 'own' },
    },
};

const ACCESS_CANNED = {
    default: 'role',
    roles: {
        admin: { read: 'all', create: true, update: 'all', delete: 'all' },
        agent: { read: 'all', create: false, update: false, delete: false },
    },
};

// One vocabulary, used by the sidebar pill, the grids and the triage bar.
const STATUS_TONES = [
    { value: 'new', label: 'New', tone: 'info' },
    { value: 'open', label: 'Open', tone: 'primary' },
    { value: 'awaiting_user', label: 'Waiting on customer', tone: 'neutral' },
    { value: 'awaiting_agent', label: 'Waiting on us', tone: 'warning' },
    { value: 'resolved', label: 'Resolved', tone: 'success' },
];

module.exports = {
    id: 'app-support-desk',
    version: 1,
    title: 'Support desk',
    description: 'A shared inbox for your team. Mail labelled "support" arrives as tickets by itself, you triage and reply from the conversation view with an AI draft or a saved reply, and an insights screen reports response times. Uses the Google or Microsoft account you signed in with.',
    category: 'Data',
    icon: 'LifeBuoy',
    tags: ['support', 'inbox', 'email', 'tickets', 'helpdesk'],

    dataModel: {
        modelVersion: 1,
        tables: [
            {
                // Grain 0 of the mailbox connector. The first nine columns are
                // written by the mailbox; everything after `status` belongs to
                // the team and is never touched by a sync.
                id: 'tbl_sdthr', key: 'tickets', name: 'Tickets', icon: 'Inbox',
                fields: [
                    { id: 'fld_sdtk', key: 'thread_key', name: 'Conversation', type: 'text', required: true, unique: true },
                    { id: 'fld_sdtsu', key: 'subject', name: 'Subject', type: 'text' },
                    { id: 'fld_sdtre', key: 'requester_email', name: 'Customer', type: 'text' },
                    { id: 'fld_sdtrn', key: 'requester_name', name: 'Customer name', type: 'text' },
                    { id: 'fld_sdtla', key: 'last_message_at', name: 'Last message', type: 'datetime' },
                    { id: 'fld_sdtmc', key: 'message_count', name: 'Messages', type: 'number' },
                    { id: 'fld_sdtun', key: 'has_unread', name: 'Unread', type: 'bool' },
                    { id: 'fld_sdtma', key: 'mailbox_address', name: 'Mailbox', type: 'text' },
                    { id: 'fld_sdtpv', key: 'provider', name: 'Provider', type: 'text' },
                    // ── team-owned from here ──
                    // Column DEFAULTs, not an action. The connector INSERTs the
                    // ticket, and nothing of ours runs at that moment — so
                    // without these every arriving ticket had a null status and
                    // a null priority: invisible to the status pills, to the
                    // "new" filter and to every insights chart that groups on
                    // them. A create_record step cannot fix it; only the DDL can.
                    { id: 'fld_sdtst', key: 'status', name: 'Status', type: 'select', options: STATUS_OPTIONS, default: 'new' },
                    { id: 'fld_sdtpr', key: 'priority', name: 'Priority', type: 'select', options: PRIORITY_OPTIONS, default: 'normal' },
                    { id: 'fld_sdtas', key: 'assignee', name: 'Assignee', type: 'text' },
                    { id: 'fld_sdtan', key: 'assignee_name', name: 'Assignee name', type: 'text' },
                    { id: 'fld_sdttg', key: 'tags', name: 'Tags', type: 'multiselect', options: [
                        { value: 'delivery', label: 'Delivery' },
                        { value: 'billing', label: 'Billing' },
                        { value: 'complaint', label: 'Complaint' },
                        { value: 'question', label: 'Question' },
                    ] },
                    // Stored, not computed: the query compiler can only aggregate
                    // real columns, so a median response time needs a column.
                    { id: 'fld_sdtfr', key: 'first_response_secs', name: 'First response (s)', type: 'number' },
                ],
                access: ACCESS_TICKETS,
            },
            {
                // Grain 1. Column keys match exactly what services/email/fetch.js
                // normalises to — the connector writes straight into these.
                id: 'tbl_sdmsg', key: 'messages', name: 'Messages', icon: 'Mail',
                fields: [
                    { id: 'fld_sdmtr', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: 'tbl_sdthr' } },
                    { id: 'fld_sdmid', key: 'provider_message_id', name: 'Message id', type: 'text', required: true, unique: true },
                    { id: 'fld_sdmtk', key: 'thread_key', name: 'Conversation', type: 'text' },
                    { id: 'fld_sdmrf', key: 'rfc822_message_id', name: 'RFC822 id', type: 'text' },
                    { id: 'fld_sdmir', key: 'in_reply_to', name: 'In reply to', type: 'text' },
                    { id: 'fld_sdmre', key: 'references', name: 'References', type: 'text' },
                    { id: 'fld_sdmpt', key: 'provider_thread_id', name: 'Provider thread', type: 'text' },
                    { id: 'fld_sdmdr', key: 'direction', name: 'Direction', type: 'select', options: [
                        { value: 'inbound', label: 'From customer' },
                        { value: 'outbound', label: 'From us' },
                    ] },
                    { id: 'fld_sdmfe', key: 'from_email', name: 'From', type: 'text' },
                    { id: 'fld_sdmfn', key: 'from_name', name: 'From name', type: 'text' },
                    { id: 'fld_sdmte', key: 'to_emails', name: 'To', type: 'text' },
                    { id: 'fld_sdmce', key: 'cc_emails', name: 'Cc', type: 'text' },
                    { id: 'fld_sdmsu', key: 'subject', name: 'Subject', type: 'text' },
                    { id: 'fld_sdmsp', key: 'snippet', name: 'Snippet', type: 'text' },
                    { id: 'fld_sdmbt', key: 'body_text', name: 'Body', type: 'richtext' },
                    { id: 'fld_sdmbh', key: 'body_html', name: 'Body (HTML)', type: 'richtext' },
                    { id: 'fld_sdmra', key: 'received_at', name: 'Received', type: 'datetime' },
                    { id: 'fld_sdmis', key: 'is_read', name: 'Read', type: 'bool' },
                    { id: 'fld_sdmha', key: 'has_attachments', name: 'Has attachments', type: 'bool' },
                    { id: 'fld_sdmab', key: 'is_auto_or_bulk', name: 'Auto/bulk', type: 'bool' },
                    { id: 'fld_sdmma', key: 'mailbox_address', name: 'Mailbox', type: 'text' },
                    { id: 'fld_sdmpr', key: 'provider', name: 'Provider', type: 'text' },
                ],
                access: ACCESS_MESSAGES,
            },
            {
                id: 'tbl_sdact', key: 'activity', name: 'Activity', icon: 'History',
                fields: [
                    { id: 'fld_sdatk', key: 'thread_key', name: 'Conversation', type: 'text' },
                    { id: 'fld_sdaat', key: 'at', name: 'When', type: 'datetime' },
                    { id: 'fld_sdaac', key: 'actor', name: 'Who', type: 'text' },
                    { id: 'fld_sdakd', key: 'kind', name: 'What', type: 'select', options: [
                        { value: 'status', label: 'Status changed' },
                        { value: 'priority', label: 'Priority changed' },
                        { value: 'assigned', label: 'Assigned' },
                        { value: 'replied', label: 'Replied' },
                        { value: 'note', label: 'Internal note' },
                    ] },
                    { id: 'fld_sdade', key: 'detail', name: 'Detail', type: 'text' },
                ],
                access: ACCESS_ACTIVITY,
            },
            {
                // Grain 2 of the mailbox connector, hanging off its MESSAGE (not
                // the ticket) via parentLevel. `file` holds a PENDING descriptor
                // pointing at the provider — nothing is downloaded until someone
                // opens or parses it.
                id: 'tbl_sdatt', key: 'attachments', name: 'Attachments', icon: 'Paperclip',
                fields: [
                    { id: 'fld_sdxms', key: 'message', name: 'Message', type: 'relation', relation: { table: 'tbl_sdmsg' } },
                    { id: 'fld_sdxid', key: 'provider_attachment_id', name: 'Attachment id', type: 'text', required: true, unique: true },
                    { id: 'fld_sdxmi', key: 'provider_message_id', name: 'Message id', type: 'text' },
                    { id: 'fld_sdxfn', key: 'filename', name: 'Filename', type: 'text' },
                    { id: 'fld_sdxmt', key: 'mime_type', name: 'Type', type: 'text' },
                    { id: 'fld_sdxsz', key: 'size', name: 'Size', type: 'number' },
                    { id: 'fld_sdxin', key: 'is_inline', name: 'Inline', type: 'bool' },
                    { id: 'fld_sdxfi', key: 'file', name: 'File', type: 'file' },
                    { id: 'fld_sdxtk', key: 'thread_key', name: 'Conversation', type: 'text' },
                ],
                access: ACCESS_ATTACHMENTS,
            },
            {
                // Where "read this invoice into a table" lands. thread_key and
                // source_file are stamped by writeTo.constants — without them an
                // extracted line names no ticket, so it cannot be shown in
                // context and the retention purge cannot find it.
                id: 'tbl_sdinv', key: 'document_lines', name: 'Document lines', icon: 'Table',
                fields: [
                    { id: 'fld_sdltk', key: 'thread_key', name: 'Conversation', type: 'text' },
                    { id: 'fld_sdlsf', key: 'source_file', name: 'Document', type: 'text' },
                    { id: 'fld_sdlds', key: 'description', name: 'Description', type: 'text' },
                    { id: 'fld_sdlqt', key: 'quantity', name: 'Quantity', type: 'number' },
                    { id: 'fld_sdlup', key: 'unit_price', name: 'Unit price', type: 'number' },
                    { id: 'fld_sdllt', key: 'line_total', name: 'Line total', type: 'number' },
                    { id: 'fld_sdlcu', key: 'currency', name: 'Currency', type: 'text' },
                    { id: 'fld_sdlat', key: 'extracted_at', name: 'Extracted', type: 'datetime' },
                ],
                access: ACCESS_DOC_LINES,
            },
            {
                id: 'tbl_sdcan', key: 'canned_replies', name: 'Saved replies', icon: 'MessageSquareQuote',
                fields: [
                    { id: 'fld_sdcti', key: 'title', name: 'Title', type: 'text', required: true },
                    { id: 'fld_sdcsh', key: 'shortcut', name: 'Shortcut', type: 'text' },
                    { id: 'fld_sdcbo', key: 'body', name: 'Body', type: 'richtext' },
                ],
                access: ACCESS_CANNED,
            },
        ],
        connectors: [
            {
                id: 'conn_sdmail',
                kind: 'mailbox',
                name: 'Support mailbox',
                provider: 'gmail',
                mode: 'personal',
                folder: 'inbox',
                // Scoped so installing the template never hoovers up a personal
                // inbox. Clear it once the desk has a mailbox of its own.
                query: 'label:support',
                lookbackDays: 7,
                maxPerRun: 100,
                includeBody: true,
                // Metadata + a pending pointer per attachment. Still no bytes at
                // sync time: they are fetched the first time someone opens or
                // parses the file, so the app never quietly copies every
                // document anyone mails you.
                includeAttachmentMeta: true,
                // Conversations become tickets; messages hang under them.
                groupIntoThreads: true,
                // The agent who clicks reply sends as themselves.
                runAs: 'viewer',
                sync: {
                    tableId: 'tbl_sdthr',
                    mode: 'upsert',
                    keyField: 'thread_key',
                    incremental: { field: 'last_message_at', format: 'iso' },
                    schedule: { everyMinutes: 2 },
                    retentionDays: 90,
                    refreshOnView: true,
                    children: [
                        {
                            tableId: 'tbl_sdmsg', level: 1, relationField: 'ticket',
                            keyField: 'provider_message_id', mode: 'upsert',
                            // The retention promise is about the CONVERSATION:
                            // kept for 90 days after its last message, then gone
                            // whole. Ageing each message out on its own
                            // `received_at` would shred a still-running ticket,
                            // and leaving it out — as this did — meant the 90
                            // days deleted the roll-up row while every body,
                            // sender and signature stayed forever.
                            retentionCascade: true,
                        },
                        {
                            // parentLevel 1: an attachment belongs to its
                            // MESSAGE. Without it the sync would relate it to the
                            // ticket instead — silently, since both are valid
                            // record ids.
                            tableId: 'tbl_sdatt', level: 2, parentLevel: 1, relationField: 'message',
                            keyField: 'provider_attachment_id', mode: 'upsert',
                            // An attachment has no date of its own — its age is
                            // its message's age.
                            retentionCascade: true,
                        },
                    ],
                },
            },
        ],
        roles: [
            { key: 'admin', label: 'Admin' },
            { key: 'agent', label: 'Agent' },
        ],
        // NULL, not 'agent'. "Everyone who can open the app is an agent" is the
        // absence of a role model dressed as one: canReadStudioApp is a
        // publication gate — it decides who may see the app exists, not who may
        // read a customer's mail. Until the owner grants a role, a viewer gets
        // the locked screen rather than a working inbox full of other people's
        // conversations.
        roleMapping: { default: null, byGroup: {} },
    },

    seed: {
        tbl_sdcan: [
            { title: 'Order is on its way', shortcut: '/onderweg', body: 'Hi,\n\nYour order has left our warehouse and should arrive within two working days.\n\nKind regards' },
            { title: 'Could you send a photo?', shortcut: '/foto', body: 'Hi,\n\nCould you send a photo of the problem? That helps us solve it faster.\n\nKind regards' },
            { title: 'Refund started', shortcut: '/refund', body: 'Hi,\n\nWe have started your refund. It usually shows up within five working days.\n\nKind regards' },
            { title: 'Thanks for letting us know', shortcut: '/dank', body: 'Hi,\n\nThank you for flagging this — we are looking into it and will come back to you.\n\nKind regards' },
        ],
    },

    definition: {
        schemaVersion: 2,
        meta: { name: 'Support desk', description: 'A shared inbox for your team.', icon: 'LifeBuoy' },
        theme: { primary: '#0F766E', ...THEME_DEFAULTS },
        homeScreenId: 'scr_sdinbox',
        roles: [
            { id: 'admin', name: 'Admin' },
            { id: 'agent', name: 'Agent' },
        ],
        screens: [
            // ══ Inbox ═══════════════════════════════════════════════════════
            {
                id: 'scr_sdinbox', name: 'Inbox', icon: 'Inbox', showInNav: true, maxWidth: 'full',
                refreshInterval: 30,
                sections: [
                    {
                        id: 'sec_sdsplit', style: { padding: 0, gap: 0, background: 'none', height: 'fill' },
                        children: [
                            // ── Sidebar ─────────────────────────────────────
                            {
                                id: 'cmp_sdside', type: 'pane',
                                props: { direction: 'vertical', scroll: 'auto' },
                                style: { span: 3, gap: 3, padding: 3, background: 'surface', height: 'fill' },
                                children: [
                                    {
                                        // No status select any more: the pills
                                        // below both SHOW the queue's shape and
                                        // filter it, in one click.
                                        id: 'cmp_sdfilter', type: 'filter_bar',
                                        props: {
                                            fields: [
                                                { name: 'q', label: 'Search', type: 'search', options: [] },
                                                { name: 'mine', label: 'Only mine', type: 'toggle', options: [] },
                                            ],
                                        },
                                        style: { span: 12, size: 'sm', gap: 2 },
                                    },
                                    {
                                        // countKey is what turns this from decoration
                                        // into the queue at a glance: the count per
                                        // status is computed in SQL and was, until
                                        // now, computed and thrown away.
                                        id: 'cmp_sdpills', type: 'badge_list',
                                        onRowClick: 'act_sdfilter',
                                        props: {
                                            source: {
                                                kind: 'aggregate', tableId: 'tbl_sdthr',
                                                groupBy: [{ field: 'status' }],
                                                aggregates: [{ fn: 'count', as: 'count' }],
                                                limit: 20,
                                            },
                                            labelKey: 'status', colorKey: 'status', countKey: 'count',
                                            colorMap: STATUS_TONES.map((s) => ({ value: s.value, label: s.label, color: s.tone })),
                                            emptyText: 'No tickets yet.',
                                        },
                                        style: { span: 12, size: 'sm', align: 'start' },
                                    },
                                    {
                                        id: 'cmp_sdlist', type: 'list',
                                        onRowClick: 'act_sdpick',
                                        props: {
                                            source: {
                                                kind: 'records', tableId: 'tbl_sdthr',
                                                filter: [
                                                    { field: 'subject', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } },
                                                    { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.statusfilter' } },
                                                ],
                                                sort: [{ field: 'last_message_at', dir: 'desc' }],
                                                limit: 100,
                                            },
                                            titleKey: 'subject',
                                            subtitleKey: 'requester_email',
                                            metaKey: 'assignee_name',
                                            timestampKey: 'last_message_at',
                                            badgeKey: 'status',
                                            badgeToneMap: STATUS_TONES,
                                            unreadKey: 'has_unread',
                                            // Which conversation is open. An inbox
                                            // that cannot show that is not an inbox.
                                            selectedWhen: 'item.thread_key == vars.thread',
                                            icon: null,
                                            emptyText: 'Nothing here yet. Label a message “support” in your mailbox and it will show up within a couple of minutes.',
                                        },
                                        style: { span: 12, size: 'sm', height: 'fill' },
                                    },
                                ],
                            },
                            // ── Conversation ────────────────────────────────
                            {
                                id: 'cmp_sdmain', type: 'pane',
                                props: { direction: 'vertical', scroll: 'none' },
                                style: { span: 9, gap: 3, padding: 3, height: 'fill' },
                                children: [
                                    {
                                        // The SUBJECT is the page title. It used to be
                                        // a labelled field inside a record_detail —
                                        // which is precisely why a conversation view
                                        // read like a form: the most important string
                                        // on screen wore a "Subject:" label and the
                                        // heading said "Conversation".
                                        id: 'cmp_sdhead', type: 'page_header',
                                        props: {
                                            title: 'Conversation', subtitle: null, icon: 'Mail', showDivider: true,
                                            titleFrom: { kind: 'formula', expr: 'vars.subject' },
                                            subtitleFrom: { kind: 'formula', expr: 'vars.requester' },
                                        },
                                        style: { span: 12, gap: 2, padding: 0 },
                                        children: [
                                            {
                                                // The assign action existed and was
                                                // wired to NOTHING, so "My queue" could
                                                // never contain anything. This button is
                                                // the whole feature.
                                                id: 'cmp_sdassignb', type: 'button',
                                                onClick: 'act_sdassign',
                                                props: { label: 'Assign to me', variant: 'secondary', iconLeft: 'UserCheck', role: 'button' },
                                                style: { size: 'sm' },
                                            },
                                            {
                                                id: 'cmp_sdfilesb', type: 'button',
                                                onClick: 'act_sdopenfiles',
                                                props: { label: 'Files', variant: 'ghost', iconLeft: 'Paperclip', role: 'button' },
                                                style: { size: 'sm' },
                                            },
                                        ],
                                    },
                                    // Triage. Every control writes on change —
                                    // no Save button between a decision and it
                                    // being true, and (showSubmit:false) no Save
                                    // button pretending there is one.
                                    {
                                        id: 'cmp_sdtriage', type: 'form',
                                        props: { name: 'triage', submitLabel: 'Save', showReset: false, showSubmit: false },
                                        style: { span: 12, gap: 2, padding: 0 },
                                        children: [
                                            {
                                                // valueFrom shows what the ticket
                                                // ALREADY is. Without it this bar was
                                                // write-only: it could set a status but
                                                // never tell you the current one.
                                                id: 'cmp_sdstat', type: 'input_select',
                                                onChange: 'act_sdstatus',
                                                props: {
                                                    name: 'status', label: 'Status', options: STATUS_OPTIONS,
                                                    required: false, defaultValue: null, placeholder: 'Set status',
                                                    valueFrom: { kind: 'formula', expr: 'vars.status' },
                                                },
                                                style: { span: 3, size: 'sm' },
                                            },
                                            {
                                                id: 'cmp_sdprio', type: 'input_select',
                                                onChange: 'act_sdpriority',
                                                props: {
                                                    name: 'priority', label: 'Priority', options: PRIORITY_OPTIONS,
                                                    required: false, defaultValue: null, placeholder: 'Set priority',
                                                    valueFrom: { kind: 'formula', expr: 'vars.priority' },
                                                },
                                                style: { span: 3, size: 'sm' },
                                            },
                                            {
                                                id: 'cmp_sdtags', type: 'input_multiselect',
                                                onChange: 'act_sdtags',
                                                props: {
                                                    name: 'tags', label: 'Tags', required: false, defaultValue: [],
                                                    valueFrom: { kind: 'formula', expr: 'vars.tags' },
                                                    options: [
                                                        { value: 'delivery', label: 'Delivery' },
                                                        { value: 'billing', label: 'Billing' },
                                                        { value: 'complaint', label: 'Complaint' },
                                                        { value: 'question', label: 'Question' },
                                                    ],
                                                },
                                                style: { span: 6, size: 'sm' },
                                            },
                                        ],
                                    },
                                    {
                                        id: 'cmp_sdthread', type: 'message_thread',
                                        props: {
                                            source: {
                                                kind: 'records', tableId: 'tbl_sdmsg',
                                                filter: [{ field: 'thread_key', op: 'eq', value: { kind: 'formula', expr: 'vars.thread' }, required: true }],
                                                sort: [{ field: 'received_at', dir: 'asc' }],
                                                limit: 100,
                                            },
                                            bodyField: 'body_text',
                                            htmlField: 'body_html',
                                            authorField: 'from_name',
                                            timestampField: 'received_at',
                                            sideField: 'direction',
                                            sideMap: [
                                                { value: 'inbound', side: 'left', tone: 'neutral' },
                                                { value: 'outbound', side: 'right', tone: 'primary' },
                                            ],
                                            attachmentsField: null,
                                            attachmentLabelKey: 'filename',
                                            citationsField: null,
                                            citationLabelKey: 'title',
                                            rowLimit: 100,
                                            emptyText: 'Pick a ticket on the left to read the conversation.',
                                        },
                                        style: { span: 12, size: 'md', height: 'fill' },
                                    },
                                    {
                                        id: 'cmp_sdform', type: 'form',
                                        onSubmit: 'act_sdsend',
                                        props: { name: 'reply', submitLabel: 'Send reply', showReset: false },
                                        style: { span: 12, gap: 2, padding: 0 },
                                        children: [
                                            {
                                                // valueFrom is what lets the AI draft and a saved
                                                // reply fill this field from outside the form.
                                                id: 'cmp_sdbody', type: 'input_textarea',
                                                props: {
                                                    name: 'body', label: 'Your reply', placeholder: 'Write a reply… or type / for a saved reply',
                                                    required: true, rows: 4,
                                                    valueFrom: { kind: 'formula', expr: 'vars.draft' },
                                                    // Type "/" and the saved replies appear inline. The
                                                    // shortcut column was decoration until this existed.
                                                    snippets: { kind: 'records', tableId: 'tbl_sdcan', limit: 50 },
                                                    snippetKey: 'shortcut',
                                                    snippetBody: 'body',
                                                    snippetLabel: 'title',
                                                },
                                                style: { span: 12 },
                                            },
                                            {
                                                id: 'cmp_sddraft', type: 'button',
                                                onClick: 'act_sddraft',
                                                props: { label: 'AI draft', variant: 'secondary', iconLeft: 'Sparkles', role: 'button' },
                                                style: { span: 3, size: 'sm' },
                                            },
                                        ],
                                    },
                                    // ── Files ───────────────────────────────
                                    // Everything about documents lives in ONE
                                    // modal, opened from the header. In the pane
                                    // it was five more children under
                                    // scroll:'none' — the reply composer was
                                    // pushed off the bottom of the screen and
                                    // nothing in the definition said so.
                                    //
                                    // The saved-replies modal is gone entirely:
                                    // the "/" snippets in the composer do that
                                    // job better, where you are actually typing.
                                    {
                                        id: 'cmp_sdfiles', type: 'modal',
                                        props: { title: 'Files on this conversation', size: 'lg', triggerLabel: null },
                                        style: { gap: 3, padding: 3 },
                                        children: [
                                            {
                                                // Pending descriptors: nothing is
                                                // downloaded until a row is clicked.
                                                id: 'cmp_sdattl', type: 'list',
                                                onRowClick: 'act_sdpickatt',
                                                props: {
                                                    source: {
                                                        kind: 'records', tableId: 'tbl_sdatt',
                                                        filter: [
                                                            { field: 'thread_key', op: 'eq', value: { kind: 'formula', expr: 'vars.thread' }, required: true },
                                                            // Signature plumbing (image001.png ×8) is
                                                            // not what anyone means by "the files on
                                                            // this conversation" — the invoice was
                                                            // drowning in it. materializeAttachment
                                                            // refuses inline images anyway.
                                                            { field: 'is_inline', op: 'eq', value: false },
                                                        ],
                                                        sort: [{ field: 'filename', dir: 'asc' }],
                                                        limit: 20,
                                                    },
                                                    titleKey: 'filename',
                                                    subtitleKey: 'mime_type',
                                                    metaKey: null,
                                                    timestampKey: null,
                                                    badgeKey: null,
                                                    badgeToneMap: [],
                                                    unreadKey: null,
                                                    selectedWhen: null,
                                                    icon: 'Paperclip',
                                                    emptyText: 'No attachments on this conversation.',
                                                },
                                                style: { span: 4, size: 'sm', height: 'md' },
                                            },
                                            {
                                                id: 'cmp_sdattv', type: 'file_preview',
                                                props: {
                                                    source: { kind: 'formula', expr: 'vars.att' },
                                                    emptyText: 'Pick a file on the left to read it here.',
                                                    allowDownload: true,
                                                },
                                                style: { span: 8, height: 'md' },
                                            },
                                            {
                                                id: 'cmp_sdsummarise', type: 'button',
                                                onClick: 'act_sdsummarise',
                                                props: { label: 'Summarise', variant: 'secondary', iconLeft: 'Sparkles', role: 'button' },
                                                style: { span: 3, size: 'sm' },
                                            },
                                            {
                                                id: 'cmp_sdextract', type: 'button',
                                                onClick: 'act_sdextract',
                                                props: { label: 'Read into a table', variant: 'secondary', iconLeft: 'Table', role: 'button' },
                                                style: { span: 3, size: 'sm' },
                                            },
                                            {
                                                id: 'cmp_sdsummary', type: 'markdown',
                                                props: {
                                                    content: '',
                                                    contentFrom: { kind: 'formula', expr: 'vars.summary' },
                                                },
                                                style: { span: 12 },
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },

            // ══ My queue ════════════════════════════════════════════════════
            {
                id: 'scr_sdmine', name: 'My queue', icon: 'UserCheck', showInNav: true, maxWidth: 'wide',
                refreshInterval: 60,
                sections: [
                    {
                        id: 'sec_sdmine', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdmineh', type: 'page_header',
                                props: { title: 'Assigned to me', subtitle: 'Everything currently on your plate.', icon: 'UserCheck', showDivider: true },
                                style: { span: 12, gap: 2, padding: 0 },
                                children: [],
                            },
                            {
                                id: 'cmp_sdminegrid', type: 'data_grid',
                                onRowClick: 'act_sdpick',
                                props: {
                                    source: {
                                        kind: 'records', tableId: 'tbl_sdthr',
                                        filter: [{ field: 'assignee', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }],
                                        sort: [{ field: 'last_message_at', dir: 'desc' }],
                                        limit: 200,
                                    },
                                    columns: [
                                        { key: 'subject', label: 'Subject', format: 'text', sortable: true },
                                        { key: 'requester_email', label: 'Customer', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge', sortable: true },
                                        { key: 'priority', label: 'Priority', format: 'badge', sortable: true },
                                        { key: 'last_message_at', label: 'Last message', format: 'date', sortable: true },
                                    ],
                                    pageSize: 25, selectable: 'none', searchable: true, rowActions: [],
                                    density: 'comfortable',
                                    emptyText: 'Nothing assigned to you right now.',
                                },
                                style: { span: 12, size: 'md', height: 'lg' },
                            },
                        ],
                    },
                ],
            },

            // ══ Customer ════════════════════════════════════════════════════
            {
                id: 'scr_sdcust', name: 'Customer', icon: 'User', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_sdcust', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdcusth', type: 'page_header',
                                props: { title: 'Customer history', subtitle: 'Everything this person has written to you before.', icon: 'User', showDivider: true },
                                style: { span: 12, gap: 2, padding: 0 },
                                children: [],
                            },
                            {
                                id: 'cmp_sdcustnote', type: 'callout',
                                props: { title: 'Pick a ticket first', text: 'Open a ticket in the Inbox — this screen then shows every other conversation from the same person. Click any row to jump straight to that conversation.', tone: 'info' },
                                style: { span: 12 },
                            },
                            {
                                id: 'cmp_sdcustlist', type: 'data_grid',
                                onRowClick: 'act_sdpick',
                                props: {
                                    source: {
                                        kind: 'records', tableId: 'tbl_sdthr',
                                        filter: [{ field: 'requester_email', op: 'eq', value: { kind: 'formula', expr: 'vars.requester' }, required: true }],
                                        sort: [{ field: 'last_message_at', dir: 'desc' }],
                                        limit: 100,
                                    },
                                    columns: [
                                        { key: 'subject', label: 'Subject', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                        { key: 'message_count', label: 'Messages', format: 'number' },
                                        { key: 'last_message_at', label: 'Last message', format: 'date' },
                                    ],
                                    pageSize: 25, selectable: 'none', searchable: false, rowActions: [],
                                    density: 'comfortable',
                                    emptyText: 'No earlier conversations from this person.',
                                },
                                style: { span: 12, size: 'md', height: 'md' },
                            },
                            {
                                id: 'cmp_sdcustact', type: 'timeline',
                                props: {
                                    source: {
                                        kind: 'records', tableId: 'tbl_sdact',
                                        filter: [{ field: 'thread_key', op: 'eq', value: { kind: 'formula', expr: 'vars.thread' }, required: true }],
                                        sort: [{ field: 'at', dir: 'desc' }],
                                        limit: 50,
                                    },
                                    titleKey: 'detail', dateKey: 'at', descriptionKey: 'actor',
                                    icon: null, rowLimit: 50, emptyText: 'Nothing has happened on this ticket yet.',
                                },
                                style: { span: 12, size: 'sm' },
                            },
                        ],
                    },
                ],
            },

            // ══ Insights ════════════════════════════════════════════════════
            {
                id: 'scr_sdstats', name: 'Insights', icon: 'BarChart3', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_sdtiles', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdt1', type: 'stat',
                                props: {
                                    label: 'Open now',
                                    value: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        filter: [{ field: 'status', op: 'eq', value: 'open' }],
                                        aggregates: [{ fn: 'count', as: 'count' }],
                                        limit: 1,
                                        pick: { row: 'first', column: 'count' },
                                    },
                                    caption: null, icon: 'Inbox',
                                    delta: { kind: 'static', value: null }, deltaFormat: 'number',
                                    trend: { kind: 'static', value: null }, positiveIsGood: false,
                                },
                                style: { span: 3, size: 'md' },
                            },
                            {
                                id: 'cmp_sdt2', type: 'stat',
                                props: {
                                    label: 'Median first response (s)',
                                    value: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        aggregates: [{ fn: 'p50', field: 'first_response_secs', as: 'median' }],
                                        limit: 1,
                                        pick: { row: 'first', column: 'median' },
                                    },
                                    caption: 'Half of replies are faster than this.', icon: 'Timer',
                                    delta: { kind: 'static', value: null }, deltaFormat: 'number',
                                    trend: { kind: 'static', value: null }, positiveIsGood: false,
                                },
                                style: { span: 3, size: 'md' },
                            },
                            {
                                id: 'cmp_sdt3', type: 'stat',
                                props: {
                                    label: 'Slowest 10% (s)',
                                    value: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        aggregates: [{ fn: 'p90', field: 'first_response_secs', as: 'p90' }],
                                        limit: 1,
                                        pick: { row: 'first', column: 'p90' },
                                    },
                                    caption: 'Where the pain actually is.', icon: 'AlertTriangle',
                                    delta: { kind: 'static', value: null }, deltaFormat: 'number',
                                    trend: { kind: 'static', value: null }, positiveIsGood: false,
                                },
                                style: { span: 3, size: 'md' },
                            },
                            {
                                // Was "SLA breaches" over an sla_breached column
                                // nothing ever wrote — a tile that read 0 for
                                // ever, next to three real numbers, which makes
                                // the real ones look untrustworthy too. Unread
                                // is a fact the mailbox actually reports.
                                id: 'cmp_sdt4', type: 'stat',
                                props: {
                                    label: 'Waiting on us',
                                    value: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        filter: [{ field: 'has_unread', op: 'eq', value: true }],
                                        aggregates: [{ fn: 'count', as: 'count' }],
                                        limit: 1,
                                        pick: { row: 'first', column: 'count' },
                                    },
                                    caption: 'Conversations with an unread customer message.', icon: 'AlertTriangle',
                                    delta: { kind: 'static', value: null }, deltaFormat: 'number',
                                    trend: { kind: 'static', value: null }, positiveIsGood: false,
                                },
                                style: { span: 3, size: 'md' },
                            },
                            {
                                id: 'cmp_sdbyst', type: 'chart',
                                props: {
                                    source: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        groupBy: [{ field: 'status' }],
                                        aggregates: [{ fn: 'count', as: 'count' }],
                                        limit: 20,
                                    },
                                    chartType: 'bar', xKey: 'status',
                                    series: [{ key: 'count', label: 'Tickets' }],
                                    title: 'Tickets by status',
                                    stacked: false, showLegend: false, showGrid: true, valueFormat: 'number',
                                },
                                style: { span: 6, height: 'md' },
                            },
                            {
                                id: 'cmp_sdbyhr', type: 'chart',
                                props: {
                                    source: {
                                        // The hour bucket folds every day onto
                                        // hour-of-day: when does the work land?
                                        kind: 'aggregate', tableId: 'tbl_sdmsg',
                                        filter: [{ field: 'direction', op: 'eq', value: 'inbound' }],
                                        groupBy: [{ field: 'received_at', bucket: 'hour', as: 'hour' }],
                                        aggregates: [{ fn: 'count', as: 'count' }],
                                        sort: [{ field: 'hour', dir: 'asc' }],
                                        limit: 24,
                                    },
                                    chartType: 'bar', xKey: 'hour',
                                    series: [{ key: 'count', label: 'Messages' }],
                                    title: 'Busiest hours',
                                    stacked: false, showLegend: false, showGrid: true, valueFormat: 'number',
                                },
                                style: { span: 6, height: 'md' },
                            },
                            {
                                id: 'cmp_sdvol', type: 'chart',
                                props: {
                                    source: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        groupBy: [{ field: 'last_message_at', bucket: 'day', as: 'day' }],
                                        aggregates: [{ fn: 'count', as: 'count' }],
                                        sort: [{ field: 'day', dir: 'asc' }],
                                        limit: 90,
                                    },
                                    chartType: 'area', xKey: 'day',
                                    series: [{ key: 'count', label: 'Tickets' }],
                                    title: 'Volume over time',
                                    stacked: false, showLegend: false, showGrid: true, valueFormat: 'number',
                                },
                                style: { span: 6, height: 'md' },
                            },
                            {
                                id: 'cmp_sdlead', type: 'data_grid',
                                props: {
                                    source: {
                                        kind: 'aggregate', tableId: 'tbl_sdthr',
                                        groupBy: [{ field: 'assignee_name' }],
                                        aggregates: [
                                            { fn: 'count', as: 'tickets' },
                                            { fn: 'p50', field: 'first_response_secs', as: 'median_response' },
                                        ],
                                        sort: [{ field: 'tickets', dir: 'desc' }],
                                        limit: 50,
                                    },
                                    columns: [
                                        { key: 'assignee_name', label: 'Agent', format: 'text' },
                                        { key: 'tickets', label: 'Tickets', format: 'number' },
                                        { key: 'median_response', label: 'Median response (s)', format: 'number' },
                                    ],
                                    pageSize: 10, selectable: 'none', searchable: false, rowActions: [],
                                    density: 'compact',
                                    emptyText: 'Nobody has been assigned a ticket yet.',
                                },
                                style: { span: 6, size: 'sm', height: 'md' },
                            },
                        ],
                    },
                ],
            },

            // ══ Settings ════════════════════════════════════════════════════
            {
                id: 'scr_sdset', name: 'Settings', icon: 'Settings', showInNav: true, maxWidth: 'wide',
                visibleToRoles: ['admin'],
                sections: [
                    {
                        id: 'sec_sdset', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdsetnote', type: 'callout',
                                props: {
                                    title: 'How the mailbox works',
                                    text: 'The Support mailbox connector under Data reads mail labelled “support” using the Google or Microsoft account you signed in to Bee Flow with. Conversations become tickets by themselves; status, priority, assignee and tags belong to your team and are never overwritten by a refresh.',
                                    tone: 'info',
                                },
                                style: { span: 12 },
                            },
                            {
                                id: 'cmp_sdtabs', type: 'tabs', props: {},
                                style: { span: 12, gap: 3 },
                                children: [
                                    {
                                        id: 'cmp_sdtab1', type: 'tab', props: { label: 'Saved replies', icon: 'MessageSquareQuote' },
                                        style: { gap: 3 },
                                        children: [
                                            {
                                                id: 'cmp_sdcang', type: 'data_grid',
                                                props: {
                                                    source: { kind: 'records', tableId: 'tbl_sdcan', limit: 100 },
                                                    columns: [
                                                        { key: 'title', label: 'Title', format: 'text', editable: true },
                                                        { key: 'shortcut', label: 'Shortcut', format: 'text', editable: true },
                                                        { key: 'body', label: 'Body', format: 'text', editable: true },
                                                    ],
                                                    pageSize: 25, searchable: true, selectable: 'none', rowActions: [],
                                                    density: 'comfortable',
                                                    emptyText: 'No saved replies yet.',
                                                },
                                                style: { span: 12, height: 'md' },
                                            },
                                            {
                                                id: 'cmp_sdcanform', type: 'form',
                                                onSubmit: 'act_sdaddcan',
                                                props: { name: 'new_reply', submitLabel: 'Add saved reply', showReset: false },
                                                style: { span: 12, gap: 2, padding: 0 },
                                                children: [
                                                    { id: 'cmp_sdcanti', type: 'input_text', props: { name: 'title', label: 'Title', required: true, placeholder: null, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6 } },
                                                    { id: 'cmp_sdcansh', type: 'input_text', props: { name: 'shortcut', label: 'Shortcut', required: false, placeholder: '/thanks', defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6 } },
                                                    { id: 'cmp_sdcanbo', type: 'input_textarea', props: { name: 'body', label: 'Body', required: true, rows: 4, placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 12 } },
                                                ],
                                            },
                                        ],
                                    },
                                    {
                                        id: 'cmp_sdtab4', type: 'tab', props: { label: 'Activity', icon: 'History' },
                                        style: { gap: 3 },
                                        children: [
                                            {
                                                id: 'cmp_sdactg', type: 'data_grid',
                                                props: {
                                                    source: {
                                                        kind: 'records', tableId: 'tbl_sdact',
                                                        sort: [{ field: 'at', dir: 'desc' }],
                                                        limit: 200,
                                                    },
                                                    columns: [
                                                        { key: 'at', label: 'When', format: 'date' },
                                                        { key: 'actor', label: 'Who', format: 'text' },
                                                        { key: 'kind', label: 'What', format: 'badge' },
                                                        { key: 'detail', label: 'Detail', format: 'text' },
                                                    ],
                                                    pageSize: 50, searchable: true, selectable: 'none', rowActions: [],
                                                    density: 'compact',
                                                    emptyText: 'No activity recorded yet.',
                                                },
                                                style: { span: 12, height: 'lg' },
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],

        actions: {
            // Opening a ticket publishes everything the detail pane binds to.
            // One variable per thing, because a binding filter can only read a
            // plain value out of vars.
            act_sdpick: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'thread', value: { kind: 'formula', expr: 'form.thread_key' } },
                    { kind: 'set_variable', name: 'ticketId', value: { kind: 'formula', expr: 'form.id' } },
                    { kind: 'set_variable', name: 'requester', value: { kind: 'formula', expr: 'form.requester_email' } },
                    { kind: 'set_variable', name: 'subject', value: { kind: 'formula', expr: 'form.subject' } },
                    // The triage bar reads these back through valueFrom. Without
                    // them the controls showed "Set status" on a ticket that had
                    // one — a bar that could write but never read.
                    { kind: 'set_variable', name: 'status', value: { kind: 'formula', expr: 'form.status' } },
                    { kind: 'set_variable', name: 'priority', value: { kind: 'formula', expr: 'form.priority' } },
                    { kind: 'set_variable', name: 'tags', value: { kind: 'formula', expr: 'form.tags' } },
                    // A new ticket starts with an empty composer rather than the
                    // previous ticket's half-written reply.
                    { kind: 'set_variable', name: 'draft', value: { kind: 'static', value: '' } },
                    { kind: 'set_variable', name: 'att', value: { kind: 'static', value: null } },
                    { kind: 'set_variable', name: 'summary', value: { kind: 'static', value: '' } },
                    // …and then land on the conversation. This step is what makes
                    // a row in My queue or Customer history DO something: without
                    // it the click only set variables on a screen that renders
                    // none of them, so clicking a ticket looked broken. Firing it
                    // from the Inbox list is a true no-op — both the run page and
                    // the editor bail on an unchanged screen id.
                    { kind: 'navigate', screenId: 'scr_sdinbox' },
                ],
            },
            // A status pill both shows the count and filters by it. Clicking the
            // one that is already active clears it, so there is no separate
            // "All" control to keep in sync with the pills. Clearing yields
            // NULL, not '': only null/undefined filter values are omitted
            // client-side — '' would be sent as `status = ''` and empty the
            // inbox with no way back.
            act_sdfilter: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'set_variable', name: 'statusfilter',
                        value: { kind: 'formula', expr: 'vars.statusfilter == form.status ? null : form.status' },
                    },
                ],
            },
            act_sdopenfiles: {
                kind: 'sequence',
                steps: [{ kind: 'open_modal', modalId: 'cmp_sdfiles' }],
            },
            act_sdstatus: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'update_record', tableId: 'tbl_sdthr',
                        recordId: { kind: 'formula', expr: 'vars.ticketId' },
                        values: { status: { kind: 'formula', expr: 'form.status' } },
                    },
                    // Keep the variable the control reads back in step with the
                    // record; otherwise valueFrom would push the OLD value back
                    // into the select on the next render and undo the change on
                    // screen while the database says otherwise.
                    { kind: 'set_variable', name: 'status', value: { kind: 'formula', expr: 'form.status' } },
                    {
                        kind: 'create_record', tableId: 'tbl_sdact',
                        values: {
                            thread_key: { kind: 'formula', expr: 'vars.thread' },
                            at: { kind: 'formula', expr: 'now' },
                            actor: { kind: 'formula', expr: 'currentUser.name' },
                            kind: { kind: 'static', value: 'status' },
                            detail: { kind: 'formula', expr: 'form.status' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_sdthr' },
                ],
            },
            act_sdpriority: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'update_record', tableId: 'tbl_sdthr',
                        recordId: { kind: 'formula', expr: 'vars.ticketId' },
                        values: { priority: { kind: 'formula', expr: 'form.priority' } },
                    },
                    { kind: 'set_variable', name: 'priority', value: { kind: 'formula', expr: 'form.priority' } },
                    {
                        kind: 'create_record', tableId: 'tbl_sdact',
                        values: {
                            thread_key: { kind: 'formula', expr: 'vars.thread' },
                            at: { kind: 'formula', expr: 'now' },
                            actor: { kind: 'formula', expr: 'currentUser.name' },
                            kind: { kind: 'static', value: 'priority' },
                            detail: { kind: 'formula', expr: 'form.priority' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_sdthr' },
                ],
            },
            act_sdtags: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'update_record', tableId: 'tbl_sdthr',
                        recordId: { kind: 'formula', expr: 'vars.ticketId' },
                        values: { tags: { kind: 'formula', expr: 'form.tags' } },
                    },
                    { kind: 'set_variable', name: 'tags', value: { kind: 'formula', expr: 'form.tags' } },
                    { kind: 'refresh', tableId: 'tbl_sdthr' },
                ],
            },
            act_sdassign: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'update_record', tableId: 'tbl_sdthr',
                        recordId: { kind: 'formula', expr: 'vars.ticketId' },
                        values: {
                            assignee: { kind: 'formula', expr: 'currentUser.id' },
                            // The NAME as well as the id: "My queue" groups by
                            // assignee, and a leaderboard of uuids is not a
                            // leaderboard.
                            assignee_name: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    {
                        kind: 'create_record', tableId: 'tbl_sdact',
                        values: {
                            thread_key: { kind: 'formula', expr: 'vars.thread' },
                            at: { kind: 'formula', expr: 'now' },
                            actor: { kind: 'formula', expr: 'currentUser.name' },
                            kind: { kind: 'static', value: 'assigned' },
                            detail: { kind: 'formula', expr: 'currentUser.name' },
                        },
                    },
                    { kind: 'toast', message: 'Assigned to you', tone: 'success' },
                    { kind: 'refresh', tableId: 'tbl_sdthr' },
                ],
            },
            // promptContext gives the model the ticket to write ABOUT; resultVar
            // lands in vars.draft, which the composer reads through valueFrom.
            act_sddraft: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'ai_generate',
                        prompt: 'You are a support agent. Write a short, friendly reply to the customer in their own language, based only on the conversation below. Messages are listed newest first. Do not invent facts, prices or dates.',
                        // Newest-first: LIMIT and the 8k serialization cap both
                        // truncate the tail, so ASC would drop the newest
                        // customer message on a long thread.
                        promptContext: {
                            kind: 'records', tableId: 'tbl_sdmsg',
                            filter: [{ field: 'thread_key', op: 'eq', value: { kind: 'formula', expr: 'vars.thread' }, required: true }],
                            sort: [{ field: 'received_at', dir: 'desc' }],
                            limit: 20,
                        },
                        output: 'text',
                        // Bare tier name: the tier map is keyed that way, and a
                        // `tier:`-prefixed value used to miss and quietly demote
                        // this to the standard model.
                        modelTier: 'thinking',
                        knowledgeBaseIds: [],
                        resultVar: 'generated',
                    },
                    { kind: 'set_variable', name: 'draft', value: { kind: 'formula', expr: 'actions.act_sddraft.result.text' } },
                ],
            },
            act_sdsend: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'send_email',
                        connectorId: 'conn_sdmail',
                        // The conversation this answers. Everything else follows
                        // from it server-side: the recipient, the "Re:" subject
                        // and the threading headers all come off the newest
                        // incoming message. Spelling `to` and `subject` out here
                        // is what suppressed the Re: prefix and overrode the
                        // sender with a rolled-up field, so the customer got a
                        // detached mail and the next sync filed it as a second
                        // ticket.
                        replyToThreadKey: { kind: 'formula', expr: 'vars.thread' },
                        body: { kind: 'formula', expr: 'form.body' },
                        bodyFormat: 'markdown',
                        recordOutbound: true,
                        resultVar: 'sent',
                    },
                    {
                        kind: 'update_record', tableId: 'tbl_sdthr',
                        recordId: { kind: 'formula', expr: 'vars.ticketId' },
                        values: { status: { kind: 'static', value: 'awaiting_user' } },
                    },
                    {
                        kind: 'create_record', tableId: 'tbl_sdact',
                        values: {
                            thread_key: { kind: 'formula', expr: 'vars.thread' },
                            at: { kind: 'formula', expr: 'now' },
                            actor: { kind: 'formula', expr: 'currentUser.name' },
                            kind: { kind: 'static', value: 'replied' },
                            detail: { kind: 'formula', expr: 'vars.subject' },
                        },
                    },
                    // Alternate between the two "empty" representations: the
                    // composer's valueFrom only pushes on CHANGE, and act_sdpick
                    // already set draft to '' — a static '' never clears a
                    // hand-typed reply after send.
                    { kind: 'set_variable', name: 'draft', value: { kind: 'formula', expr: "vars.draft === '' ? null : ''" } },
                    // Narrowed: only the conversation reloads, not the whole screen.
                    { kind: 'refresh', tableId: 'tbl_sdmsg' },
                    { kind: 'toast', message: 'Reply sent', tone: 'success' },
                ],
            },
            // Opening an attachment is just publishing which one — the viewer
            // redeems the bytes itself on first use.
            act_sdpickatt: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'att', value: { kind: 'formula', expr: 'form.file' } },
                    { kind: 'set_variable', name: 'attname', value: { kind: 'formula', expr: 'form.filename' } },
                    // A new document must not sit under the previous one's summary.
                    { kind: 'set_variable', name: 'summary', value: { kind: 'static', value: '' } },
                ],
            },
            // The general capability, proven: a document → typed rows → a table,
            // stamped with where it came from. `constants` is what stops the
            // rows being orphans.
            act_sdextract: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'ai_extract',
                        source: { kind: 'formula', expr: 'vars.att' },
                        schema: [
                            { name: 'description', type: 'string', description: 'What the line is for', required: true },
                            { name: 'quantity', type: 'number', description: 'How many' },
                            { name: 'unit_price', type: 'number', description: 'Price per unit, excluding tax' },
                            { name: 'line_total', type: 'number', description: 'Total for this line' },
                            { name: 'currency', type: 'string', description: 'ISO currency code, e.g. EUR' },
                        ],
                        modelTier: 'thinking',
                        knowledgeBaseIds: [],
                        writeTo: {
                            tableId: 'tbl_sdinv',
                            mapping: {
                                description: 'description',
                                quantity: 'quantity',
                                unit_price: 'unit_price',
                                line_total: 'line_total',
                                currency: 'currency',
                            },
                            constants: {
                                thread_key: { kind: 'formula', expr: 'vars.thread' },
                                source_file: { kind: 'formula', expr: 'vars.attname' },
                                extracted_at: { kind: 'formula', expr: 'now' },
                            },
                        },
                        resultVar: 'extracted',
                    },
                    { kind: 'refresh', tableId: 'tbl_sdinv' },
                    {
                        kind: 'create_record', tableId: 'tbl_sdact',
                        values: {
                            thread_key: { kind: 'formula', expr: 'vars.thread' },
                            at: { kind: 'formula', expr: 'now' },
                            actor: { kind: 'formula', expr: 'currentUser.name' },
                            kind: { kind: 'static', value: 'note' },
                            detail: { kind: 'formula', expr: 'vars.attname' },
                        },
                    },
                    { kind: 'toast', message: 'Document read into the table', tone: 'success' },
                ],
            },
            // A plain-language answer about the open document. ai_generate can
            // read attachments directly, so this needs no new capability — only
            // somewhere to PUT the answer, which is what markdown.contentFrom is.
            act_sdsummarise: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'ai_generate',
                        prompt: 'Summarise the attached document for a support agent in at most six bullet points. State amounts, dates and reference numbers exactly as written. If something is not in the document, do not mention it.',
                        promptContext: { kind: 'static', value: null },
                        attachments: { kind: 'formula', expr: 'vars.att' },
                        output: 'text',
                        modelTier: 'thinking',
                        knowledgeBaseIds: [],
                        resultVar: 'summarised',
                    },
                    { kind: 'set_variable', name: 'summary', value: { kind: 'formula', expr: 'actions.act_sdsummarise.result.text' } },
                ],
            },
            act_sdaddcan: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_sdcan',
                        values: {
                            title: { kind: 'formula', expr: 'form.title' },
                            shortcut: { kind: 'formula', expr: 'form.shortcut' },
                            body: { kind: 'formula', expr: 'form.body' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_sdcan' },
                    { kind: 'toast', message: 'Saved reply added', tone: 'success' },
                ],
            },
        },
    },
};
