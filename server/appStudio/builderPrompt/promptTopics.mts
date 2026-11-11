/**
 * App Studio builder: the passages of the builder prompt that are served on request.
 *
 * They were part of the cached system prompt and are rare: an app around a mailbox, and showing,
 * comparing and copying the owner's documents. The prompt keeps one line that says what exists
 * (builderPrompt.js), app_inspect_catalog serves the passage as a topic (catalogTopics.mts).
 */

/** How to build an app around a mailbox connector in thread mode. */
export const MAIL_APPS_TOPIC = `MAIL APPS (a mailbox connector in thread mode: conversations, messages and attachments tables).
Show a conversation with message_thread over the messages table; for attachments point attachmentsSource at the attachments table with attachmentMatchKey "provider_message_id", attachmentFileKey "file" and inlineContentIdKey "content_id", and wire onAttachmentClick (it fires with { item: <the attachment row> }) to an action that sets a variable for a file_preview; without it a chip opens its file in a new tab.
cid: images in the HTML mail show from the app's own files only when the attachments table has the text column content_id (an app built before it existed adds it with app_upsert_table; the sync then fills it on the next run).
AUTOMATIC PROCESSING: app_set_mailbox_hook makes the connector run one action for every NEW conversation (target "thread") or every new incoming message (target "inbound_message") on the server, as the owner, with { item: <the new row> } in scope: an ai_generate step summarises, update_record files the result. That action may only hold steps that run unattended (create_record, update_record, ai_generate, ai_extract, kb_query, dataset_query, file_intake, generate_file, fill_document, generate_presentation, redact_pdf, with condition/switch) and NEVER send_email, so build it as its own action; replies stay a button a person presses. Rows that already exist are not processed, and runs are capped per sync and per minute.`;

/** Showing, picking, comparing and copying the owner's documents. */
export const DOCUMENTS_TOPIC = `DOCUMENTS beyond filling one.
A filled document, a generated file and a generated presentation are the same attachment descriptor: a \`file_preview\` component shows it (set viewer "app" for the app's own PDF reader instead of the browser's: file name as title, zoom, fit, rotate, fullscreen; textLayer true makes the text selectable), \`download_file\` hands it over and a send_email attachment carries it.
SHOWING a document is not filling one: \`document_viewer\` shows one read-only (source = its id, or a formula/record field holding one), \`input_document\` lets the user pick from the documentIds/folderId you list, \`document_compare\` shows what changed between two (left/right ids; only left = its versions).
An app shows ONLY documents you put into it that way, so list every document a dynamic binding may point at in a picker.
\`copy_document\` {source, templateDocumentId?, name?, resultVar} copies one into the owner's library — a presentation wearing templateDocumentId's look — and its result ({documentId, …}) bound to a document_compare's right side shows what the conversion changed.`;
