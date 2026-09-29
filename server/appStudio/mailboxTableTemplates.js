/**
 * The fixed table shapes a mailbox connector writes (see mailboxConnector.js).
 *
 * A leaf on purpose: no require at all. componentSpecs.js serves these in the
 * editor catalog, and the mobile tests load componentSpecs.js, so whatever this
 * file requires becomes part of what ci.yml's mobile filter has to list
 * (mobile/src/lib/serverClosure.test.ts checks it). Reading them from
 * mailboxConnector.js pulled services/email/fetch and ~1,070 other server files
 * into that set.
 */

'use strict';

/**
 * `unique: true` on provider_message_id is load-bearing: dataModel.ddlForTable
 * turns it into a UNIQUE index, which is what makes the upsert an upsert.
 */
const MAILBOX_TABLE_TEMPLATE = Object.freeze({
    name: 'Messages',
    icon: 'mail',
    fields: [
        { key: 'provider_message_id', name: 'Message id', type: 'text', unique: true, required: true },
        { key: 'thread_key', name: 'Thread', type: 'text' },
        { key: 'provider_thread_id', name: 'Provider thread id', type: 'text' },
        { key: 'rfc822_message_id', name: 'RFC822 message id', type: 'text' },
        { key: 'in_reply_to', name: 'In reply to', type: 'text' },
        { key: 'references', name: 'References', type: 'text' },
        { key: 'direction', name: 'Direction', type: 'select', options: ['inbound', 'outbound'] },
        { key: 'from_email', name: 'From', type: 'text' },
        { key: 'from_name', name: 'From name', type: 'text' },
        { key: 'to_emails', name: 'To', type: 'text' },
        { key: 'cc_emails', name: 'Cc', type: 'text' },
        { key: 'subject', name: 'Subject', type: 'text' },
        { key: 'subject_normalized', name: 'Subject (normalised)', type: 'text' },
        { key: 'snippet', name: 'Snippet', type: 'text' },
        { key: 'body_text', name: 'Body', type: 'richtext' },
        { key: 'body_html', name: 'Body (HTML)', type: 'richtext' },
        { key: 'received_at', name: 'Received', type: 'datetime' },
        { key: 'is_read', name: 'Read', type: 'bool' },
        { key: 'has_attachments', name: 'Has attachments', type: 'bool' },
        { key: 'is_auto_or_bulk', name: 'Auto/bulk', type: 'bool' },
        { key: 'labels', name: 'Labels', type: 'text' },
        { key: 'mailbox_address', name: 'Mailbox', type: 'text' },
        { key: 'provider', name: 'Provider', type: 'text' },
        { key: 'raw_size', name: 'Size', type: 'number' },
    ],
});

/**
 * The conversation roll-up (grain 0 when groupIntoThreads is on).
 *
 * Only the columns the MAILBOX owns. A ticket table adds status/priority/
 * assignee next to these; upsert leaves those alone because the connector never
 * emits them.
 */
const MAILBOX_THREAD_TABLE_TEMPLATE = Object.freeze({
    name: 'Conversations',
    icon: 'inbox',
    fields: [
        { key: 'thread_key', name: 'Conversation', type: 'text', unique: true, required: true },
        { key: 'subject', name: 'Subject', type: 'text' },
        { key: 'requester_email', name: 'Customer', type: 'text' },
        { key: 'requester_name', name: 'Customer name', type: 'text' },
        { key: 'last_message_at', name: 'Last message', type: 'datetime' },
        { key: 'message_count', name: 'Messages', type: 'number' },
        { key: 'has_unread', name: 'Unread', type: 'bool' },
        { key: 'mailbox_address', name: 'Mailbox', type: 'text' },
        { key: 'provider', name: 'Provider', type: 'text' },
    ],
});

const MAILBOX_ATTACHMENT_TABLE_TEMPLATE = Object.freeze({
    name: 'Attachments',
    icon: 'paperclip',
    fields: [
        { key: 'provider_attachment_id', name: 'Attachment id', type: 'text', unique: true, required: true },
        // Redeeming the bytes needs the MESSAGE id as well as the attachment id;
        // without it the row describes a file nobody can fetch.
        { key: 'provider_message_id', name: 'Message id', type: 'text' },
        { key: 'filename', name: 'Filename', type: 'text' },
        { key: 'mime_type', name: 'Type', type: 'text' },
        { key: 'size', name: 'Size', type: 'number' },
        { key: 'is_inline', name: 'Inline', type: 'bool' },
        // A PENDING descriptor (see mailboxAttachments.js). The bytes are not
        // downloaded here; the first viewer or AI step redeems this in place and
        // it becomes an ordinary studio_attachment.
        { key: 'file', name: 'File', type: 'file' },
    ],
});

module.exports = {
    MAILBOX_TABLE_TEMPLATE,
    MAILBOX_THREAD_TABLE_TEMPLATE,
    MAILBOX_ATTACHMENT_TABLE_TEMPLATE,
    // Served in the editor catalog so the table can be created before the
    // connector has ever been saved.
    MAILBOX_TABLE_TEMPLATES: Object.freeze({
        message: MAILBOX_TABLE_TEMPLATE,
        thread: MAILBOX_THREAD_TABLE_TEMPLATE,
        attachment: MAILBOX_ATTACHMENT_TABLE_TEMPLATE,
    }),
};
