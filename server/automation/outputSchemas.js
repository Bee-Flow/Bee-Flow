/**
 * Output Schemas — JSON-schema-lite definitions matching what the actual
 * integration tools return at runtime. Used by:
 *   1. The Builder agent — to know exactly what fields are available
 *      downstream (so it doesn't have to guess "items" vs "results").
 *   2. The runner — during dry-run, to synthesize realistic placeholder
 *      output for side-effect tools (which we never call in dry-run).
 *
 * These shapes were verified against the actual `return` statements in
 * server/integrations/*. When you change a tool's output shape, update
 * the matching entry here.
 *
 * The "shape" field is a flat description of the top-level fields the
 * AI most commonly needs to bind to. The "sample" field is a realistic
 * value used for dry-run synthesis.
 */

const OUTPUT_SCHEMAS = {
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
            date: new Date().toISOString(), body: 'Email body…', conversationId: 'conv-1', hasAttachments: false,
        },
    },
    outlook_read_many: {
        // `messages` is the first array: it is the list a "for each" binds to.
        shape: {
            messages: 'array of { id, from, to, cc, subject, date, body, conversationId, hasAttachments, attachments } (each exactly as outlook_read returns it; body cut at 20,000 characters)',
            count: 'integer (messages read)',
            notFound: 'array of string (ids Outlook does not know)',
            failed: 'array of { id, error }',
            truncated: 'boolean (only when more than 100 ids were given; the first 100 were read)',
            error: 'string (only when not one message could be read)',
        },
        sample: {
            messages: [{
                id: 'msg-1', from: 'Sender <sender@example.com>', to: 'Me <me@example.com>', cc: '', subject: 'Sample',
                date: new Date().toISOString(), body: 'Email body…', conversationId: 'conv-1', hasAttachments: false,
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
    nextcloud_create_spreadsheet: {
        // `appended` is present only with ifExists:"append" (officeDocuments.js):
        // how many rows were added below the existing ones.
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean', appended: 'integer|undefined' },
        sample: { success: true, path: '/Reports/invoices.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 5120, created: true, updated: false },
    },
    nextcloud_create_document: {
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean' },
        sample: { success: true, path: '/Reports/summary.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 8192, created: true, updated: false },
    },
    nextcloud_create_presentation: {
        // `webUrl` is the Nextcloud deep link that opens the deck in Nextcloud
        // Office; null when the file id could not be read back (connector hop
        // without a public base URL).
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean', fileId: 'string|null', webUrl: 'string|null', slideCount: 'integer', warnings: 'string[]' },
        sample: { success: true, path: '/Presentations/q3-review.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: 61440, created: true, updated: false, fileId: '4711', webUrl: 'https://cloud.example.org/f/4711', slideCount: 7, warnings: [] },
    },
    create_presentation: {
        shape: { success: 'boolean', downloadUrl: 'string', filename: 'string', size: 'integer', slideCount: 'integer', houseStyle: 'boolean', warnings: 'string[]' },
        sample: { success: true, downloadUrl: '/api/storage/file/users/u1/presentations/1700000000_ab12cd_q3-review.pptx', filename: 'q3-review.pptx', size: 61440, slideCount: 7, houseStyle: true, warnings: [] },
    },
    create_word_document: {
        // Kept in storage: downloadUrl + size. With nextcloudPath (and Nextcloud
        // reachable) the upload fields + webUrl instead. `houseStyle` is the
        // name of the Word house style applied, or false.
        shape: { success: 'boolean', downloadUrl: 'string|undefined', filename: 'string', size: 'integer|undefined', path: 'string|undefined', webUrl: 'string|null|undefined', houseStyle: 'string|boolean' },
        sample: { success: true, downloadUrl: '/api/storage/file/users/u1/documents/1700000000_ab12cd_offerte-acme.docx', filename: 'offerte-acme.docx', size: 12288, houseStyle: 'Kantoorstijl' },
    },
    nextcloud_deck_create_card: {
        // Returns the raw Deck card JSON (POST .../cards). Demo write tool.
        shape: { id: 'integer', title: 'string', description: 'string', stackId: 'integer', type: 'string', order: 'integer', archived: 'boolean', duedate: 'string|null', createdAt: 'integer', lastModified: 'integer' },
        sample: { id: 4521, title: 'Follow up with Nextcloud', description: '', stackId: 34, type: 'plain', order: 999, archived: false, duedate: null, createdAt: Math.floor(Date.now() / 1000), lastModified: Math.floor(Date.now() / 1000) },
    },

    // ── Nextcloud reads (added 2026-09-11) ────────────────────────
    // The Nextcloud family is the biggest coverage hole in this table: 146
    // tools, 9 of them declared. With no entry, builder_inspect_tool answers
    // `shape: null` + "No declared output schema… or just bind defensively" —
    // while the lean prompt promises it returns "the exact param names + output
    // shape, don't guess". A build on the demo box duly burned rounds on
    // "I'll assume content, or maybe text" and on assuming list_rooms returns
    // a bare array (it returns { count, rooms }). These shapes are read off the
    // executors' actual return statements, not inferred.
    // Nextcloud Tables. Without these, `inspect` said "no declared output
    // schema" for all of them: one measured build bound its row step to
    // `output.items[0].id` (the array is `tables`), and another keyed the row
    // by the AI's field names instead of the column TITLES the tool matches on
    // — the two mistakes that broke every build against this app (2026-09-12).
    nextcloud_tables_list: {
        shape: { count: 'integer', tables: 'array of { id, title, emoji, ownership, isShared, archived, rowsCount, columnsCount }' },
        sample: { count: 2, tables: [{ id: 4, title: 'Facturen', emoji: '🧾', ownership: 'admin', isShared: false, archived: false, rowsCount: 0, columnsCount: 6 }] },
    },
    nextcloud_tables_list_columns: {
        // Read this before writing a row: `values` on a create/update is keyed
        // by the column TITLE exactly as it appears here, not by its id and not
        // by whatever the upstream AI step happened to call the field.
        shape: { tableId: 'integer', count: 'integer', columns: 'array of { id, title, type, subtype, mandatory }' },
        sample: { tableId: 4, count: 2, columns: [{ id: 1, title: 'Datum', type: 'datetime', subtype: 'date', mandatory: false }, { id: 2, title: 'Leverancier', type: 'text', subtype: 'line', mandatory: false }] },
    },
    nextcloud_tables_create: {
        shape: { success: 'boolean', table: 'object { id, title, emoji, ownership, isShared, archived, rowsCount, columnsCount }' },
        sample: { success: true, table: { id: 7, title: 'Facturen', emoji: '🧾', ownership: 'admin', isShared: false, archived: false, rowsCount: 0, columnsCount: 0 } },
    },
    nextcloud_tables_create_row: {
        shape: { success: 'boolean', row: 'object { id, tableId, createdBy, createdAt, values }' },
        sample: { success: true, row: { id: 31, tableId: 4, createdBy: 'admin', createdAt: '2026-09-12 10:00:00', values: { Datum: '2026-09-19', Leverancier: 'Noordlicht Energie B.V.', Totaal: 1554.25 } } },
    },
    nextcloud_tables_update_row: {
        shape: { success: 'boolean', row: 'object { id, tableId, lastEditBy, lastEditAt, values }' },
        sample: { success: true, row: { id: 31, tableId: 4, lastEditBy: 'admin', lastEditAt: '2026-09-12 10:05:00', values: { Totaal: 1554.25 } } },
    },

    nextcloud_list_files: {
        // fileOperations.js returns { path, count, items } — the array is
        // `items`, NOT `files` or `results`. Without this entry inspect said
        // "no declared output schema" and three measured builds guessed three
        // different names, each costing a dry-run round; one shipped a forEach
        // over `.files`, a field that does not exist. Read off the executor.
        shape: { path: 'string', count: 'integer', items: 'array of { name, path, type ("file"|"folder"), size, contentType, modified, fileId }' },
        sample: { path: '/Invoices', count: 1, items: [{ name: 'Invoice-2026-001.pdf', path: '/Invoices/Invoice-2026-001.pdf', type: 'file', size: 51200, contentType: 'application/pdf', modified: 'Thu, 10 Sep 2026 09:00:00 GMT', fileId: '1234' }] },
    },
    nextcloud_read_file: {
        // fileOperations.js: rich documents (PDF/DOCX/XLSX) also carry
        // extractedVia + meta; plain text omits them. The text is in `content`
        // — NOT `text` or `body`. On an image-only PDF, a binary file or a
        // failed extraction it returns { error, size, contentType } instead,
        // with no path and no content — bind defensively or wire an on-error
        // branch.
        shape: { path: 'string', size: 'integer', contentType: 'string', extractedVia: 'string|undefined', truncated: 'boolean', content: 'string', meta: 'object|undefined' },
        sample: { path: '/Invoices/Invoice-2026-001.pdf', size: 51200, contentType: 'application/pdf', extractedVia: 'pdf-text-layer', truncated: false, content: 'INVOICE\nVendor: Acme BV\nAmount: EUR 1.240,00\nDue: 2026-10-01', meta: { pages: 2 } },
    },
    nextcloud_talk_list_rooms: {
        // { count, rooms } — the array is under `rooms`, so a forEach binds
        // overRef: "steps.<id>.output.rooms". Each room carries 17 fields;
        // token is the identity (it survives a rename), name is the display
        // name.
        shape: { count: 'integer', rooms: 'array of { token, type, name, description, unreadMessages, unreadMention, lastActivity, lastMessage, participantType, canStartCall, readOnly, hasCall, callFlag, callRecording, callStartTime, objectType, objectId }' },
        sample: { count: 1, rooms: [{ token: '78dp7n2a', type: 2, name: 'Ops', description: '', unreadMessages: 0, unreadMention: false, lastActivity: Math.floor(Date.now() / 1000), lastMessage: { id: 91, actor: 'Alice', message: 'Morning', timestamp: Math.floor(Date.now() / 1000) }, participantType: 1, canStartCall: true, readOnly: 0, hasCall: false, callFlag: 0, callRecording: 0, callStartTime: 0, objectType: '', objectId: '' }] },
    },
    nextcloud_deck_list_boards: {
        shape: { count: 'integer', boards: 'array of { id, title, color, archived, stacks }' },
        sample: { count: 1, boards: [{ id: 2, title: 'Demo Ops', color: '0082c9', archived: false, stacks: [{ id: 5, title: 'Inbox' }] }] },
    },
    nextcloud_deck_list_stacks: {
        shape: { boardId: 'integer', count: 'integer', stacks: 'array of { id, title, order, cardCount }' },
        sample: { boardId: 2, count: 2, stacks: [{ id: 5, title: 'Inbox', order: 0, cardCount: 3 }, { id: 6, title: 'Done', order: 1, cardCount: 7 }] },
    },

    // ── GitHub writes ─────────────────────────────────────────────
    github_create_repo: {
        shape: { id: 'integer', name: 'string', fullName: 'string', htmlUrl: 'string', private: 'boolean' },
        sample: { id: 1, name: 'new-repo', fullName: 'org/new-repo', htmlUrl: 'https://github.com/org/new-repo', private: false },
    },

    // ── Notification (built-in step) ──────────────────────────────
    // Not technically a tool, but exposed for symmetry.

    // ── Webpages ─────────────────────────────────────────────────
    webpages_list: {
        shape: { webpages: 'array of { id, name, description, isOwner, isPublished, updatedAt }' },
        sample: { webpages: [
            { id: 'wp-sample-1', name: 'Move Move Facturen', description: 'Fuel invoice tracker', isOwner: true, isPublished: false, updatedAt: new Date().toISOString() },
        ], message: '1 accessible webpage.' },
    },
    webpage_db_schema: {
        shape: { tables: 'array of { name, sql, columns: [{ name, type, notNull, defaultValue, primaryKey }] }', message: 'string' },
        sample: { tables: [
            { name: 'facturen', sql: 'CREATE TABLE facturen (...)', columns: [
                { name: 'id', type: 'TEXT', notNull: 1, defaultValue: null, primaryKey: 1 },
                { name: 'datum', type: 'TEXT', notNull: 1, defaultValue: null, primaryKey: 0 },
                { name: 'incl_btw', type: 'REAL', notNull: 1, defaultValue: null, primaryKey: 0 },
            ] },
        ], message: '1 table: facturen' },
    },
    webpage_db_query: {
        shape: { rows: 'array of row objects', columns: 'array of column names', truncated: 'boolean', message: 'string' },
        sample: { rows: [{ id: 'sample-row', datum: '2026-05-05', incl_btw: 69.99 }], columns: ['id', 'datum', 'incl_btw'], truncated: false, message: 'Returned 1 row.' },
    },
    webpage_db_exec: {
        shape: { changes: 'integer', lastInsertRowid: 'integer', multi: 'boolean', message: 'string' },
        sample: { changes: 1, lastInsertRowid: 42, multi: false, message: 'OK — 1 row affected, lastInsertRowid=42.' },
    },
    webpage_file_read: {
        shape: { file: 'string', content: 'string', lineCount: 'integer', message: 'string' },
        sample: { file: 'js', content: '// sample js', lineCount: 1, message: 'Read 1 line.' },
    },
    webpage_file_write: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'File written.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_file_replace: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'Replaced 1 occurrence.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_file_patch: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'Patched lines 5–7.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_set_metadata: {
        shape: { message: 'string', webpageId: 'string' },
        sample: { message: 'Webpage metadata updated.', webpageId: 'wp-sample-1' },
    },
    webpage_create: {
        shape: { webpageId: 'string', url: 'string', name: 'string', message: 'string' },
        sample: { webpageId: 'wp-new-1', url: '/app/webpages/wp-new-1', name: 'New Webpage', message: 'Created webpage "New Webpage".' },
    },

    // ── AI-only integrations promoted to automation actions ──
    generate_image: {
        shape: { url: 'string', prompt: 'string', mimeType: 'string', sizeBytes: 'integer' },
        sample: { url: 'https://storage.example/img-abc.png', prompt: '<your prompt>', mimeType: 'image/png', sizeBytes: 248_000 },
    },
    generate_video: {
        shape: { url: 'string', durationSec: 'number', mimeType: 'string', prompt: 'string' },
        sample: { url: 'https://storage.example/vid-abc.mp4', durationSec: 6, mimeType: 'video/mp4', prompt: '<your prompt>' },
    },
    elevenlabs_music: {
        shape: { url: 'string', durationSec: 'number', prompt: 'string' },
        sample: { url: 'https://storage.example/track.mp3', durationSec: 30, prompt: '<your prompt>' },
    },
    elevenlabs_tts: {
        shape: { url: 'string', durationSec: 'number', voiceId: 'string', text: 'string' },
        sample: { url: 'https://storage.example/tts.mp3', durationSec: 4, voiceId: 'EXAVITQu4vr4xnSDxMaL', text: '<spoken text>' },
    },
    elevenlabs_sfx: {
        shape: { url: 'string', durationSec: 'number', prompt: 'string' },
        sample: { url: 'https://storage.example/sfx.mp3', durationSec: 2, prompt: '<sound description>' },
    },
    // ── Google Sheets ──
    sheets_list: {
        shape: { results: 'array of { id, name, url, modifiedTime }', total: 'integer' },
        sample: {
            results: [
                { id: '1AbCDeFgHiJkLmNoPqRsTuV', name: 'Invoice tracker 2026', url: 'https://docs.google.com/spreadsheets/d/1AbCDeFgHiJkLmNoPqRsTuV/edit', modifiedTime: '2026-05-12T10:23:00Z' },
                { id: '1WxYzAbCDeFgHiJkLmNoPq', name: 'Customer leads', url: 'https://docs.google.com/spreadsheets/d/1WxYzAbCDeFgHiJkLmNoPq/edit', modifiedTime: '2026-05-09T14:51:00Z' },
            ],
            total: 2,
        },
    },
    sheets_get_values: {
        shape: { spreadsheetId: 'string', range: 'string', values: 'array of arrays (rows × columns)', rowCount: 'integer', colCount: 'integer' },
        sample: {
            spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV',
            range: "Sheet1!A1:C3",
            values: [
                ['Name', 'Email', 'Amount'],
                ['Alice', 'alice@example.com', '125.00'],
                ['Bob', 'bob@example.com', '90.50'],
            ],
            rowCount: 3,
            colCount: 3,
        },
    },
    sheets_append_rows: {
        shape: { spreadsheetId: 'string', updatedRange: 'string', rowsAppended: 'integer', cellsAppended: 'integer' },
        sample: { spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV', updatedRange: 'Sheet1!A5:C5', rowsAppended: 1, cellsAppended: 3 },
    },
    sheets_update_range: {
        shape: { spreadsheetId: 'string', updatedRange: 'string', rowsUpdated: 'integer', cellsUpdated: 'integer' },
        sample: { spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV', updatedRange: 'Sheet1!B2:B2', rowsUpdated: 1, cellsUpdated: 1 },
    },
    sheets_create: {
        shape: { spreadsheetId: 'string', url: 'string', title: 'string' },
        sample: { spreadsheetId: '1NewSheetIdABCDEF', url: 'https://docs.google.com/spreadsheets/d/1NewSheetIdABCDEF/edit', title: 'New spreadsheet' },
    },

    // ── Google Slides ──
    slides_list: {
        shape: { results: 'array of { id, name, url, modifiedTime }', total: 'integer' },
        sample: {
            results: [
                { id: '1PrEsIdSlIdEsAbCdEfG', name: 'Q1 review template', url: 'https://docs.google.com/presentation/d/1PrEsIdSlIdEsAbCdEfG/edit', modifiedTime: '2026-04-22T08:11:00Z' },
            ],
            total: 1,
        },
    },
    slides_get: {
        shape: { presentationId: 'string', title: 'string', slides: 'array of { index, objectId, text }', slideCount: 'integer' },
        sample: {
            presentationId: '1PrEsIdSlIdEsAbCdEfG',
            title: 'Q1 review template',
            slides: [
                { index: 0, objectId: 'p1', text: 'Q1 Review\nPrepared by: {{NAME}}' },
                { index: 1, objectId: 'p2', text: 'Highlights\n- Revenue up 12%\n- Two new partners' },
            ],
            slideCount: 2,
        },
    },
    slides_replace_text: {
        shape: { presentationId: 'string', replacements: 'integer (total substitutions across deck)', replacementCount: 'integer (pairs supplied)' },
        sample: { presentationId: '1PrEsIdSlIdEsAbCdEfG', replacements: 4, replacementCount: 2 },
    },
    slides_create: {
        shape: { presentationId: 'string', url: 'string', title: 'string' },
        sample: { presentationId: '1NewSlidesIdABCDEF', url: 'https://docs.google.com/presentation/d/1NewSlidesIdABCDEF/edit', title: 'New presentation' },
    },
    slides_export_pdf: {
        shape: { presentationId: 'string', url: 'string', mimeType: 'string' },
        sample: { presentationId: '1PrEsIdSlIdEsAbCdEfG', url: 'https://www.googleapis.com/drive/v3/files/1PrEsIdSlIdEsAbCdEfG/export?mimeType=application%2Fpdf', mimeType: 'application/pdf' },
    },

    transcribe_audio: {
        shape: { text: 'string', durationSec: 'number', language: 'string', segments: 'array of { start, end, text, speaker? }' },
        sample: {
            text: '<full transcript>',
            durationSec: 120,
            language: 'en',
            segments: [
                { start: 0, end: 4.2, text: '<segment>', speaker: 'SPEAKER_00' },
                { start: 4.2, end: 8.5, text: '<segment>', speaker: 'SPEAKER_01' },
            ],
        },
    },
};

function getOutputSchema(toolName) {
    return OUTPUT_SCHEMAS[toolName] || null;
}

/**
 * Synthesize a typed placeholder output for dry-run when a tool has a
 * declared schema. Falls back to a name-pattern guess (so unschema'd
 * write tools still produce a plausible shape the AI can bind against),
 * and a last-resort sentinel object.
 *
 * Keyed by integration TOOL name only. A `data_extraction` step has no entry
 * here on purpose — its shape is per step, from its own `fields` — and never
 * reaches this function: execDataExtraction synthesises its dry-run output
 * from those fields itself (typed samples, `dryRunSynthesised: true`).
 *
 * Returns a deep clone so callers can mutate freely.
 */
function synthesizeDryRunOutput(toolName, args) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (schema?.sample !== undefined) {
        return JSON.parse(JSON.stringify(schema.sample));
    }
    // Name-pattern fallback. Most write actions follow a verb suffix
    // convention; we synthesise a shape that matches what those tools
    // actually return at runtime so an automation built on top of an
    // unschema'd tool still gets a workable bind target during dry-run.
    return inferShapeFromName(toolName, args);
}

const VERB_SUFFIX_SHAPES = [
    { match: /_send(_message)?$/,     sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_reply$/,                sample: () => ({ sent: true, id: 'sample-id', message: 'Reply sent (dry-run preview).' }) },
    { match: /_compose$/,              sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_post$/,                 sample: () => ({ id: 'sample-id', published: true, url: 'https://example.com/sample-id' }) },
    { match: /_create(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', created: true, url: 'https://example.com/sample-id' }) },
    { match: /_add(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', added: true }) },
    { match: /_update(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', updated: true }) },
    { match: /_set(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', set: true }) },
    { match: /_delete(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', deleted: true }) },
    { match: /_remove(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', removed: true }) },
    { match: /_move(_[a-z_]+)?$/,      sample: () => ({ id: 'sample-id', moved: true }) },
    { match: /_share(_[a-z_]+)?$/,     sample: () => ({ id: 'sample-id', shared: true, url: 'https://example.com/share/sample-id' }) },
    { match: /_write$/,                sample: () => ({ id: 'sample-id', written: true }) },
    { match: /_attach$/,               sample: () => ({ id: 'sample-id', attached: true }) },
];

function inferShapeFromName(toolName, args) {
    if (typeof toolName !== 'string') {
        return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
    }
    for (const { match, sample } of VERB_SUFFIX_SHAPES) {
        if (match.test(toolName)) {
            return { ...sample(), _dryRun: true, _inferred: true, wouldHaveCalled: toolName };
        }
    }
    return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
}

/**
 * Lightweight description of a tool's shape, used in the Builder system
 * prompt so the AI can bind correct paths on the first try. Returns a
 * string like "results: array of { id, subject, ... }, total: integer".
 */
function describeShape(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema?.shape) return null;
    if (schema.shape._string) return `(returns a string: ${schema.shape._string})`;
    return Object.entries(schema.shape).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/**
 * Output field names whose value is an ARRAY — the things a per-step `forEach`
 * can iterate over (overRef = `steps.<id>.output.<field>`). Derived from the
 * declared shape (values described as "array …") plus any array fields in the
 * sample. Returns [] when the tool returns no iterable list / is unknown.
 */
function iterableFieldsOf(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return [];
    const out = new Set();
    if (schema.shape && typeof schema.shape === 'object' && !schema.shape._string) {
        for (const [k, v] of Object.entries(schema.shape)) {
            if (k.startsWith('_')) continue;
            if (typeof v === 'string' && /array/i.test(v)) out.add(k);
        }
    }
    const sample = schema.sample;
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        for (const [k, v] of Object.entries(sample)) {
            if (Array.isArray(v)) out.add(k);
        }
    }
    return [...out];
}

/** Whether a tool's output contains (or is) a list the AI can forEach over. */
function producesList(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return false;
    if (Array.isArray(schema.sample)) return true;            // top-level array output
    return iterableFieldsOf(toolName).length > 0;
}

module.exports = { OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput, describeShape, iterableFieldsOf, producesList };
