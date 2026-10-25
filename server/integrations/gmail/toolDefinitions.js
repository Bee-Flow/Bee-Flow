// @typecheck strict
/**
 * The Gmail tool definitions in OpenAI function-calling format, exported
 * as GMAIL_TOOLS by ../gmailTools.js.
 */

'use strict';

/**
 * Tool definitions in OpenAI function-calling format.
 */
const GMAIL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'gmail_search',
            description: 'Search the user\'s Gmail inbox for emails matching a query. Returns a list of email summaries (sender, subject, date, snippet). Use Gmail search syntax like "from:someone@example.com", "subject:invoice", "after:2025/01/01", "has:attachment", "is:unread", or just plain keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Gmail search query (supports Gmail search operators like from:, subject:, after:, before:, has:attachment, is:unread, label:, etc.)'
                    },
                    // `default` is not decoration: the builder renders a
                    // property's default as the field's placeholder
                    // (mapping/ToolInputForm.jsx -> describeExample), so
                    // without it the cap existed only in this description —
                    // and the field itself sat behind "more options" showing
                    // an empty box. Authors ran a search that matched 201
                    // mails, processed 10, and had nothing on screen that
                    // said so (BFSF-358A).
                    maxResults: {
                        type: 'integer',
                        default: 10,
                        description: 'Maximum number of emails to return (default 10). The tool pages through Gmail automatically, so in an automation you can set this higher — up to 500 — to process more matching emails in one go.'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_read',
            description: 'Read the full content of a specific email by its message ID. Use this after gmail_search to get the complete body of an email.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Gmail message ID to read (from gmail_search results)'
                    }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_read_attachment',
            description: 'Download and extract the text content of an attachment from a Gmail email. Handles PDFs (text + OCR), Word/Excel/CSV documents, images (PNG/JPG via OCR), and plain-text files. Use gmail_read first (or a Gmail trigger) to get each attachment\'s messageId, attachmentId, filename and mimeType. Returns the extracted text AND a `sourceHandle` you can pass to `drive_upload_file` (or other upload tools) to forward the original bytes — never bind base64 directly.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: {
                        type: 'string',
                        description: 'The Gmail message ID that contains the attachment (from gmail_read results / trigger.output.attachments[i].messageId)'
                    },
                    attachmentId: {
                        type: 'string',
                        description: 'The attachment ID (from gmail_read results)'
                    },
                    filename: {
                        type: 'string',
                        description: 'The filename of the attachment (used to pick the right extractor and for logging)'
                    },
                    mimeType: {
                        type: 'string',
                        description: 'The attachment MIME type (from gmail_read results). Determines how the content is extracted (PDF / Office / image OCR / text). Optional — inferred from the filename when omitted.'
                    }
                },
                required: ['messageId', 'attachmentId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_compose',
            description: 'Compose and send a new email or reply to an existing email thread. The user will see a preview with Send, Save as Draft, and Discard buttons before anything is sent — no email is sent automatically. Use this whenever the user asks you to write, draft, send, reply to, or forward an email.\n\nIMPORTANT: When replying, set replyToMessageId to the message ID of the email being replied to (from gmail_search / gmail_read results, or the attached Gmail thread context). The tool will then auto-fill the recipient and subject from the original message — you only need to pass `body` and `replyToMessageId`. If you *do* pass `to` / `subject` on a reply, your values override the auto-derived ones. For forwards, prefix the subject with "Fwd: " and include the original email body.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address(es), comma-separated for multiple. Optional when replyToMessageId is set — the tool derives the recipient from the original message (Reply-To or From header).'
                    },
                    cc: {
                        type: 'string',
                        description: 'Optional: CC recipient email address(es), comma-separated'
                    },
                    bcc: {
                        type: 'string',
                        description: 'Optional: BCC recipient email address(es), comma-separated'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line. Optional when replyToMessageId is set — the tool derives it from the original message and prefixes "Re: " automatically. For forwards, pass explicitly with "Fwd: " prefix.'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body text (plain text). For forwards, include the original email content.'
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'REQUIRED for replies: Gmail message ID of the email being replied to (from gmail_search or gmail_read results, or trigger.output.messageId for a Gmail-triggered automation). This makes Gmail render the reply inline in the original conversation. Omit only for new emails and forwards.'
                    },
                    threadId: {
                        type: 'string',
                        description: 'Optional: Gmail thread ID. Pass this when you have only the threadId (e.g. trigger.output.threadId) and not a specific messageId — the tool will look up the latest message in the thread to derive the reply headers. Prefer replyToMessageId when both are available.'
                    }
                },
                required: ['body']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_list_labels',
            description: 'List the Gmail labels in the user\'s mailbox — system labels (INBOX, UNREAD, STARRED, IMPORTANT, …) and the user\'s own labels. Use this to discover a label name/ID before adding or removing labels.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_modify_labels',
            description: 'Add and/or remove labels on a Gmail message. Labels may be given by name (e.g. "Work") or by ID (e.g. "Label_3", "INBOX", "UNREAD") — names are resolved to IDs automatically. Use this for custom labelling; for common cases prefer gmail_mark_read / gmail_mark_unread / gmail_archive.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'string', description: 'The Gmail message ID to modify (from gmail_search / gmail_read / trigger).' },
                    addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to add.' },
                    removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to remove.' }
                },
                required: ['messageId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_mark_read',
            description: 'Mark a Gmail message as read (removes the UNREAD label).',
            parameters: { type: 'object', properties: { messageId: { type: 'string', description: 'The Gmail message ID.' } }, required: ['messageId'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_mark_unread',
            description: 'Mark a Gmail message as unread (adds the UNREAD label).',
            parameters: { type: 'object', properties: { messageId: { type: 'string', description: 'The Gmail message ID.' } }, required: ['messageId'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_archive',
            description: 'Archive a Gmail message — removes it from the inbox (removes the INBOX label).',
            parameters: { type: 'object', properties: { messageId: { type: 'string', description: 'The Gmail message ID.' } }, required: ['messageId'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_trash',
            description: 'Move a Gmail message to the trash (reversible — does not permanently delete).',
            parameters: { type: 'object', properties: { messageId: { type: 'string', description: 'The Gmail message ID.' } }, required: ['messageId'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_create_draft',
            description: 'Create a Gmail draft (saved in Drafts, not sent). Supports new drafts and reply drafts. For replies, set replyToMessageId so the draft threads correctly — to/subject are then derived from the original message if omitted.',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Recipient email address(es), comma-separated. Optional when replyToMessageId is set.' },
                    cc: { type: 'string', description: 'Optional CC recipient(s), comma-separated.' },
                    bcc: { type: 'string', description: 'Optional BCC recipient(s), comma-separated.' },
                    subject: { type: 'string', description: 'Subject line. Optional when replyToMessageId is set (derived and "Re: " prefixed).' },
                    body: { type: 'string', description: 'Draft body text (plain text).' },
                    replyToMessageId: { type: 'string', description: 'Optional: message ID this draft replies to (threads the draft inline).' }
                },
                required: ['body']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_read_many',
            description: 'Read the full content of many Gmail emails at once (up to 100): Gmail is asked in batches of 50, so 40 emails cost one request instead of 40. Pass the message ids from gmail_search (`results[*].id`). Returns `messages`, each shaped exactly like gmail_read (from, to, subject, date, body, and attachments carrying the messageId and attachmentId that gmail_read_attachment needs); a body is cut at 20,000 characters. Ids Gmail does not know are listed in `notFound`. In an automation, use this instead of running gmail_read once per email.',
            parameters: {
                type: 'object',
                properties: {
                    messageIds: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Gmail message ids, at most 100 (e.g. the `id` of every gmail_search result). A list of search results works too: each one\'s id is used.'
                    }
                },
                required: ['messageIds']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'gmail_bulk_modify',
            description: 'Change many Gmail emails in ONE request (up to 1000): add or remove labels, mark them read or unread, or archive them. In an automation, use this instead of running gmail_modify_labels, gmail_mark_read, gmail_mark_unread or gmail_archive once per email. Labels may be given by name ("Invoices") or ID ("Label_3", "STARRED"). It does not move emails to Trash or Spam: that is gmail_trash, one email at a time.',
            parameters: {
                type: 'object',
                properties: {
                    messageIds: { type: 'array', items: { type: 'string' }, description: 'Gmail message ids to change, at most 1000 (e.g. the `id` of every gmail_search result).' },
                    addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to add to every message.' },
                    removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to remove from every message.' },
                    markRead: { type: 'boolean', description: 'Mark every message as read.' },
                    markUnread: { type: 'boolean', description: 'Mark every message as unread.' },
                    archive: { type: 'boolean', description: 'Archive every message (take it out of the inbox).' }
                },
                required: ['messageIds']
            }
        }
    }
];

module.exports = { GMAIL_TOOLS };
