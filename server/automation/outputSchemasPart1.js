// @typecheck strict
// Part 1 of OUTPUT_SCHEMAS (split out of outputSchemas.js; key order is preserved there).

const OUTPUT_SCHEMAS_PART_1 = {
    // ── Gmail ─────────────────────────────────────────────────────
    gmail_search: {
        shape: {
            results: 'array of { id, from, to, subject, date, snippet }',
            total: 'integer (estimated total result count)',
            message: 'string (only present when results is empty)',
        },
        sample: {
            results: [
                { id: 'msg-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700', snippet: 'Beste klant, hierbij uw factuur...' },
                { id: 'msg-2', from: 'biller@example.com', to: 'me@example.com', subject: 'Factuur januari', date: 'Mon, 06 Apr 2026 09:15:42 -0700', snippet: 'Bedrag: €234.50' },
            ],
            total: 2,
        },
    },
    gmail_read: {
        shape: {
            id: 'string', threadId: 'string',
            from: 'string', to: 'string', subject: 'string',
            date: 'string', body: 'string (plain text)',
            attachments: 'array of { attachmentId, filename, mimeType, size, canOCR, messageId, threadId }',
        },
        sample: {
            id: 'msg-1', threadId: 'th-1',
            from: 'sender@example.com', to: 'me@example.com',
            subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700',
            body: 'Beste klant,\n\nHierbij ontvangt u onze factuur met nummer 2026-001.\n\nBedrag: €1,234.50 (incl. BTW)\nBetalingstermijn: 30 dagen.\n\nMet vriendelijke groet.',
            // Non-empty so the builder's variable tree / LoopOverPicker / auto-map
            // expose the per-attachment fields. Each item carries messageId so a
            // "for each attachment" loop can feed gmail_read_attachment directly.
            attachments: [
                { attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678, canOCR: true, messageId: 'msg-1', threadId: 'th-1' },
            ],
        },
    },
    gmail_read_attachment: {
        shape: {
            filename: 'string', mimeType: 'string',
            content: 'string (extracted text)', charCount: 'integer',
            truncated: 'boolean', extractedVia: 'string (pdfjs|azure|mistral|documentParser|utf8)',
            sourceHandle: 'opaque { kind, messageId, attachmentId, filename, mimeType, size } — pass to drive_upload_file / nextcloud_upload_file to forward the raw bytes',
            error: 'string (only when extraction failed; sourceHandle still provided)',
        },
        sample: {
            filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf',
            content: 'INVOICE 2026-001\nDate: 2026-04-06\nAmount Due: €1,234.50',
            charCount: 1847, truncated: false, extractedVia: 'pdfjs',
            sourceHandle: { kind: 'gmail_attachment', messageId: 'msg-1', attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678 },
        },
    },
    gmail_compose: {
        // Automation runtime sets autoSend=true, so the live result is the
        // sent-email shape, not a draft envelope. Sample matches what the
        // tool actually returns now (see integrations/gmailTools.js).
        shape: {
            sent: 'boolean', messageId: 'string', threadId: 'string',
            to: 'string', subject: 'string', message: 'string',
        },
        sample: { sent: true, messageId: 'msg-sent-1', threadId: 'th-sent-1', to: 'recipient@example.com', subject: 'Sample subject', message: 'Email sent.' },
    },
    gmail_compose_reply: {
        shape: { sent: 'boolean', messageId: 'string', threadId: 'string', message: 'string' },
        sample: { sent: true, messageId: 'msg-reply-1', threadId: 'th-1', message: 'Reply sent.' },
    },
    gmail_list_labels: {
        shape: { labels: 'array of { id, name, type }' },
        sample: { labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'UNREAD', name: 'UNREAD', type: 'system' },
            { id: 'Label_3', name: 'Work', type: 'user' },
        ] },
    },
    gmail_modify_labels: {
        shape: { messageId: 'string', labelIds: 'array of string (labels after the change)', addLabelIds: 'array of string', removeLabelIds: 'array of string', modified: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX', 'Label_3'], addLabelIds: ['Label_3'], removeLabelIds: [], modified: true },
    },
    gmail_mark_read: {
        shape: { messageId: 'string', labelIds: 'array of string', read: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX'], read: true },
    },
    gmail_mark_unread: {
        shape: { messageId: 'string', labelIds: 'array of string', read: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX', 'UNREAD'], read: false },
    },
    gmail_archive: {
        shape: { messageId: 'string', labelIds: 'array of string', archived: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: [], archived: true },
    },
    gmail_trash: {
        shape: { messageId: 'string', trashed: 'boolean', labelIds: 'array of string' },
        sample: { messageId: 'msg-1', trashed: true, labelIds: ['TRASH'] },
    },
    gmail_read_many: {
        // `messages` is the first array: it is the list a "for each" binds to.
        shape: {
            messages: 'array of { id, threadId, from, to, subject, date, body, attachments } (each exactly as gmail_read returns it; body cut at 20,000 characters)',
            count: 'integer (messages read)',
            notFound: 'array of string (ids Gmail does not know)',
            failed: 'array of { id, error }',
            truncated: 'boolean (only when more than 100 ids were given; the first 100 were read)',
            error: 'string (only when not one message could be read)',
        },
        sample: {
            messages: [
                {
                    id: 'msg-1', threadId: 'th-1', from: 'sender@example.com', to: 'me@example.com',
                    subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700',
                    body: 'Beste klant,\n\nHierbij ontvangt u onze factuur met nummer 2026-001.',
                    attachments: [
                        { attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678, canOCR: true, messageId: 'msg-1', threadId: 'th-1' },
                    ],
                },
            ],
            count: 1,
            notFound: [],
            failed: [],
        },
    },
    gmail_bulk_modify: {
        shape: {
            modified: 'integer (messages changed)',
            messageIds: 'array of string',
            addLabelIds: 'array of string (label ids added)',
            removeLabelIds: 'array of string (label ids removed; UNREAD = marked read, INBOX = archived)',
            message: 'string (only when there was nothing to change)',
        },
        sample: { modified: 2, messageIds: ['msg-1', 'msg-2'], addLabelIds: ['Label_3'], removeLabelIds: ['UNREAD'] },
    },
    gmail_create_draft: {
        shape: { draftId: 'string', messageId: 'string', threadId: 'string', to: 'string', subject: 'string', message: 'string' },
        sample: { draftId: 'draft-1', messageId: 'msg-draft-1', threadId: 'th-1', to: 'recipient@example.com', subject: 'Re: Sample subject', message: 'Draft saved.' },
    },

    // ── Google Calendar ───────────────────────────────────────────
    calendar_list_events: {
        shape: {
            results: 'array of { id, summary, start, end, location, attendees, description, htmlLink }',
            total: 'integer',
        },
        sample: {
            results: [
                { id: 'evt-1', summary: 'Team standup', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 5400_000).toISOString(), location: '', attendees: [], description: '', htmlLink: 'https://calendar.google.com/event?eid=…' },
            ],
            total: 1,
        },
    },
    calendar_search_events: {
        shape: { results: 'array (same as calendar_list_events.results)' },
        sample: { results: [] },
    },
    calendar_create_event: {
        shape: { id: 'string', htmlLink: 'string', summary: 'string', start: 'string', end: 'string' },
        sample: { id: 'evt-new', htmlLink: 'https://calendar.google.com/event?eid=…', summary: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() },
    },

    // ── Google Drive ──────────────────────────────────────────────
    drive_search: {
        shape: { results: 'array of { id, name, mimeType, webViewLink, modifiedTime, size }' },
        sample: { results: [{ id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/file-1', modifiedTime: new Date().toISOString(), size: 12345 }] },
    },
    drive_list_files: {
        shape: { results: 'array (same as drive_search.results)' },
        sample: { results: [{ id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/file-1', modifiedTime: new Date().toISOString(), size: 12345 }] },
    },
    drive_read_file: {
        shape: { id: 'string', name: 'string', mimeType: 'string', content: 'string (text content)' },
        sample: { id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', content: 'Sample document text…' },
    },

    // ── Google Docs ───────────────────────────────────────────────
    docs_create: {
        shape: { documentId: 'string', title: 'string', url: 'string' },
        sample: { documentId: 'doc-1', title: 'New document', url: 'https://docs.google.com/document/d/doc-1' },
    },
    docs_append_text: {
        shape: { documentId: 'string', appended: 'boolean', textLength: 'integer' },
        sample: { documentId: 'doc-1', appended: true, textLength: 42 },
    },
    docs_read: {
        shape: { documentId: 'string', title: 'string', content: 'string' },
        sample: { documentId: 'doc-1', title: 'Doc title', content: 'Document body text…' },
    },

    // ── Outlook (Microsoft) ───────────────────────────────────────
    outlook_search: {
        shape: { results: 'array of { id, from, subject, preview, receivedDateTime, hasAttachments }' },
        sample: { results: [{ id: 'msg-1', from: 'sender@example.com', subject: 'Sample', preview: '…', receivedDateTime: new Date().toISOString(), hasAttachments: false }] },
    },
    // What integrations/outlookTools.js shapeOutlookMessage returns: `date`,
    // not `receivedDateTime`, and `attachments` only when the email has any.
    outlook_read: {
        shape: {
            id: 'string', from: 'string', to: 'string', cc: 'string', subject: 'string',
            date: 'string', body: 'string (plain text)', conversationId: 'string', hasAttachments: 'boolean',
            attachments: 'array of { id, filename, mimeType, size, canOCR } (only when hasAttachments)',
        },
        sample: {
            id: 'msg-1', from: 'Sender <sender@example.com>', to: 'Me <me@example.com>', cc: '', subject: 'Sample',
            date: new Date().toISOString(), body: 'Email body…', conversationId: 'conv-1', hasAttachments: true,
            attachments: [{ id: 'att-1', filename: 'offerte-q4.pdf', mimeType: 'application/pdf', size: 48213, canOCR: true }],
        },
    },
    outlook_read_many: {
        // `messages` is the first array: it is the list a "for each" binds to.
        shape: {
            messages: 'array of { id, from, to, cc, subject, date, body, conversationId, hasAttachments, attachments: array of { id, filename, mimeType, size, canOCR } } (each exactly as outlook_read returns it; body cut at 20,000 characters; attachments only when the email has any)',
            count: 'integer (messages read)',
            notFound: 'array of string (ids Outlook does not know)',
            failed: 'array of { id, error }',
            truncated: 'boolean (only when more than 100 ids were given; the first 100 were read)',
            error: 'string (only when not one message could be read)',
        },
        sample: {
            messages: [{
                id: 'msg-1', from: 'Sender <sender@example.com>', to: 'Me <me@example.com>', cc: '', subject: 'Sample',
                date: new Date().toISOString(), body: 'Email body…', conversationId: 'conv-1', hasAttachments: true,
                attachments: [{ id: 'att-1', filename: 'offerte-q4.pdf', mimeType: 'application/pdf', size: 48213, canOCR: true }],
            }],
            count: 1, notFound: [], failed: [],
        },
    },

    // ── Microsoft Calendar ────────────────────────────────────────
    ms_calendar_list_events: {
        shape: { events: 'array of { id, subject, start, end, location, attendees }' },
        sample: { events: [{ id: 'evt-1', subject: 'Sample meeting', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), location: '', attendees: [] }] },
    },

    // ── Web search ────────────────────────────────────────────────
    // agent_search returns a Markdown STRING — wrap at the runner so the
    // automation can still bind to "the search result". We expose a
    // string-typed schema and the dry-run synth returns sample markdown.
    agent_search: {
        shape: { _string: 'markdown string with results, sources, citations' },
        sample: '# Search Results for: "sample query"\n\n[1] Result title — Snippet of result one.\n\n[2] Another title — Snippet of result two.\n\n## Sources\n[1] [Result title](https://example.com/1)\n[2] [Another title](https://example.com/2)',
    },

    // ── KB ────────────────────────────────────────────────────────
    kb_search: {
        shape: { results: 'array of { chunk_id, content, source, score }' },
        sample: { results: [{ chunk_id: 'chunk-1', content: 'Sample knowledge content…', source: 'doc.pdf', score: 0.92 }] },
    },
    kb_fetch: {
        shape: { chunks: 'array of { chunk_id, content, source }' },
        sample: { chunks: [{ chunk_id: 'chunk-1', content: 'Sample chunk body', source: 'doc.pdf' }] },
    },

    // ── YouTrack ──────────────────────────────────────────────────
    youtrack_search_issues: {
        shape: { results: 'array of { id, summary, state, assignee, url, project }', count: 'integer' },
        sample: { results: [{ id: 'PROJ-1', summary: 'Sample issue', state: 'Open', assignee: 'someone', url: 'https://youtrack.example.com/issue/PROJ-1', project: 'PROJ' }], count: 1 },
    },
    youtrack_get_issue: {
        shape: { id: 'string', summary: 'string', description: 'string', state: 'string', assignee: 'string', comments: 'array' },
        sample: { id: 'PROJ-1', summary: 'Sample issue', description: 'Issue body…', state: 'Open', assignee: 'someone', comments: [] },
    },

    // ── Outlook / Microsoft 365 ───────────────────────────────────
    // There is no `outlook_send` tool: sending is outlook_compose with the
    // runtime's autoSend. Graph's sendMail/reply answer 202 without a body,
    // so unlike gmail_compose there is no messageId to hand on; the
    // conversationId is only known for a reply.
    outlook_compose: {
        shape: {
            sent: 'boolean', to: 'string', subject: 'string',
            replyToMessageId: 'string|null', conversationId: 'string|null', message: 'string',
        },
        sample: { sent: true, to: 'recipient@example.com', subject: 'Sample subject', replyToMessageId: null, conversationId: null, message: 'Email sent to recipient@example.com.' },
    },
    ms_calendar_create_event: {
        shape: { id: 'string', subject: 'string', start: 'string', end: 'string', webLink: 'string' },
        sample: { id: 'evt-new', subject: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), webLink: 'https://outlook.office.com/calendar/event/evt-new' },
    },

    // ── Calendar writes ───────────────────────────────────────────
    calendar_update_event: {
        shape: { id: 'string', summary: 'string', updated: 'boolean', htmlLink: 'string' },
        sample: { id: 'evt-1', summary: 'Updated event', updated: true, htmlLink: 'https://calendar.google.com/event?eid=…' },
    },
    calendar_delete_event: {
        shape: { id: 'string', deleted: 'boolean' },
        sample: { id: 'evt-1', deleted: true },
    },

    // ── YouTrack ──────────────────────────────────────────────────
    youtrack_create_issue: {
        shape: { id: 'string', summary: 'string', url: 'string', project: 'string', alreadyExists: 'boolean (true when an identical issue already existed — no new issue was created)' },
        sample: { id: 'PROJ-42', summary: 'Created issue', url: 'https://youtrack.example.com/issue/PROJ-42', project: 'PROJ' },
    },
    youtrack_update_issue: {
        shape: { id: 'string', updated: 'boolean' },
        sample: { id: 'PROJ-42', updated: true },
    },
    youtrack_add_comment: {
        shape: { id: 'string', issueId: 'string', commentId: 'string', added: 'boolean' },
        sample: { id: 'comment-1', issueId: 'PROJ-42', commentId: 'comment-1', added: true },
    },
    youtrack_link_issues: {
        shape: { linked: 'boolean', issueId: 'string', targetIssueId: 'string', linkType: 'string' },
        sample: { linked: true, issueId: 'PROJ-43', targetIssueId: 'PROJ-42', linkType: 'duplicates' },
    },
    youtrack_get_issue_comments: {
        shape: { results: 'array of { id, author, text, created }', count: 'integer' },
        sample: { results: [{ id: 'comment-1', author: 'Some One', text: 'Sample comment', created: new Date().toISOString() }], count: 1 },
    },
    youtrack_find_user: {
        shape: { results: 'array of { login, fullName, email }', count: 'integer' },
        sample: { results: [{ login: 'jane.doe', fullName: 'Jane Doe', email: 'jane@example.com' }], count: 1 },
    },
    youtrack_change_assignee: {
        shape: { issueId: 'string', assignee: 'string', updated: 'boolean' },
        sample: { issueId: 'PROJ-42', assignee: 'jane.doe', updated: true },
    },
    youtrack_log_work: {
        shape: { issueId: 'string', minutes: 'integer', logged: 'boolean' },
        sample: { issueId: 'PROJ-42', minutes: 30, logged: true },
    },
    youtrack_manage_tags: {
        shape: { issueId: 'string', tag: 'string', action: 'string', updated: 'boolean' },
        sample: { issueId: 'PROJ-42', tag: 'triage', action: 'add', updated: true },
    },

    // ── Drive / Docs writes ───────────────────────────────────────
    drive_create_folder: {
        shape: { id: 'string', name: 'string', webViewLink: 'string' },
        sample: { id: 'folder-1', name: 'New folder', webViewLink: 'https://drive.google.com/drive/folders/folder-1' },
    },
    drive_move_file: {
        shape: { id: 'string', moved: 'boolean', newParentId: 'string' },
        sample: { id: 'file-1', moved: true, newParentId: 'folder-1' },
    },
    drive_upload_file: {
        shape: { fileId: 'string', name: 'string', webViewLink: 'string', parents: 'array of string', mimeType: 'string', bytesUploaded: 'number', updated: 'boolean' },
        sample: { fileId: 'file-1', name: 'factuur.pdf', webViewLink: 'https://drive.google.com/file/d/file-1/view', parents: ['folder-supp'], mimeType: 'application/pdf', bytesUploaded: 81234, updated: false },
    },

    // ── Contacts ──────────────────────────────────────────────────
    contacts_create: {
        shape: { resourceName: 'string', name: 'string', email: 'string' },
        sample: { resourceName: 'people/c12345', name: 'Sample contact', email: 'sample@example.com' },
    },

    // ── LinkedIn ──────────────────────────────────────────────────
    linkedin_create_post: {
        shape: { id: 'string', url: 'string', published: 'boolean' },
        sample: { id: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1', published: true },
    },

    // ── SignRequest ───────────────────────────────────────────────
    signrequest_send_document: {
        shape: { id: 'string', uuid: 'string', url: 'string', signers: 'array of { email, status }' },
        sample: { id: 'sr-1', uuid: 'doc-uuid-1', url: 'https://signrequest.com/d/doc-uuid-1', signers: [{ email: 'recipient@example.com', status: 'pending' }] },
    },

    // ── Nextcloud Mail / Talk / Calendar / Notifications ──────────
    // Shapes verified against the tool modules' actual return statements.
    nextcloud_mail_send: {
        shape: { success: 'boolean', outboxId: 'integer', to: 'string', subject: 'string' },
        sample: { success: true, outboxId: 1, to: 'recipient@example.com', subject: 'Sample subject' },
    },
    nextcloud_talk_send_message: {
        shape: { success: 'boolean', message: '{ id, actor, actorId, message, timestamp }' },
        sample: { success: true, message: { id: 1, actor: 'Alice', actorId: 'alice', message: 'Message text', timestamp: Math.floor(Date.now() / 1000) } },
    },
    nextcloud_calendar_create_event: {
        shape: { success: 'boolean', calendar: 'string', uid: 'string', etag: 'string' },
        sample: { success: true, calendar: 'personal', uid: 'nc-evt-1@cloud.example.com', etag: '"abc123"' },
    },
    nextcloud_notifications_send: {
        shape: { success: 'boolean', userId: 'string', sentToSelf: 'boolean', shortMessage: 'string', longMessage: 'string|null' },
        sample: { success: true, userId: 'alice', sentToSelf: true, shortMessage: 'Heads up', longMessage: null },
    },
    nextcloud_activity_list: {
        shape: { count: 'integer', activities: 'array of { id, type, subject, message, actor, objectType, objectId, objectName, link, datetime }' },
        sample: { count: 1, activities: [{ id: 42, type: 'file_created', subject: 'You created Report.pdf', message: '', actor: 'alice', objectType: 'files', objectId: 1234, objectName: '/Documents/Report.pdf', link: 'https://cloud.example.com/f/1234', datetime: new Date().toISOString() }] },
    },
    nextcloud_calendar_list_events: {
        shape: { calendar: 'string', count: 'integer', events: 'array of { uid, summary, description, location, attendees, dtstart, dtend, organizer, allDay }' },
        sample: { calendar: 'personal', count: 1, events: [{ uid: 'evt-1@cloud.example.com', summary: 'Standup', description: null, location: null, attendees: [], dtstart: new Date(Date.now() + 600_000).toISOString(), dtend: new Date(Date.now() + 2400_000).toISOString(), organizer: null, allDay: false }] },
    },
};

module.exports = { OUTPUT_SCHEMAS_PART_1 };
