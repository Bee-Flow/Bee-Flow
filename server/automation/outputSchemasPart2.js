// @typecheck strict
// Part 2 of OUTPUT_SCHEMAS (split out of outputSchemas.js; key order is preserved there).

const OUTPUT_SCHEMAS_PART_2 = {
    nextcloud_create_spreadsheet: {
        // `appended` is present only with ifExists:"append" (officeDocuments.js):
        // how many rows were added below the existing ones.
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean', appended: 'integer|undefined' },
        sample: { success: true, path: '/Reports/invoices.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 5120, created: true, updated: false },
        echo: { path: 'path' },
    },
    nextcloud_create_document: {
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean' },
        sample: { success: true, path: '/Reports/summary.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: 8192, created: true, updated: false },
        echo: { path: 'path' },
    },
    nextcloud_create_presentation: {
        // `webUrl` is the Nextcloud deep link that opens the deck in Nextcloud
        // Office; null when the file id could not be read back (connector hop
        // without a public base URL).
        shape: { success: 'boolean', path: 'string', contentType: 'string', bytes: 'integer', created: 'boolean', updated: 'boolean', fileId: 'string|null', webUrl: 'string|null', slideCount: 'integer', warnings: 'string[]' },
        sample: { success: true, path: '/Presentations/q3-review.pptx', contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: 61440, created: true, updated: false, fileId: '4711', webUrl: 'https://cloud.example.org/f/4711', slideCount: 7, warnings: [] },
        echo: { path: 'path' },
    },
    create_presentation: {
        shape: { success: 'boolean', downloadUrl: 'string', filename: 'string', size: 'integer', slideCount: 'integer', houseStyle: 'boolean', warnings: 'string[]' },
        sample: { success: true, downloadUrl: '/api/storage/file/users/u1/presentations/1700000000_ab12cd_q3-review.pptx', filename: 'q3-review.pptx', size: 61440, slideCount: 7, houseStyle: true, warnings: [] },
    },
    create_word_document: {
        // Kept in storage: downloadUrl + size; saved to Nextcloud or OneDrive: path + webUrl. houseStyle: the style's name or false.
        shape: { success: 'boolean', downloadUrl: 'string|undefined', filename: 'string', size: 'integer|undefined', path: 'string|undefined', webUrl: 'string|null|undefined', houseStyle: 'string|boolean' },
        sample: { success: true, downloadUrl: '/api/storage/file/users/u1/documents/1700000000_ab12cd_offerte-acme.docx', filename: 'offerte-acme.docx', size: 12288, houseStyle: 'Kantoorstijl' },
    },
    create_spreadsheet: { shape: { success: 'boolean', downloadUrl: 'string|undefined', filename: 'string', size: 'integer|undefined', sheets: 'integer', path: 'string|undefined', webUrl: 'string|null|undefined' },
        sample: { success: true, downloadUrl: '/api/storage/file/users/u1/documents/1700000000_ab12cd_budget-2026.xlsx', filename: 'budget-2026.xlsx', size: 8192, sheets: 2 } },
    nextcloud_deck_create_card: {
        // Returns the raw Deck card JSON (POST .../cards). Demo write tool.
        shape: { id: 'integer', title: 'string', description: 'string', stackId: 'integer', type: 'string', order: 'integer', archived: 'boolean', duedate: 'string|null', createdAt: 'integer', lastModified: 'integer' },
        sample: { id: 4521, title: 'Follow up with Nextcloud', description: '', stackId: 34, type: 'plain', order: 999, archived: false, duedate: null, createdAt: Math.floor(Date.now() / 1000), lastModified: Math.floor(Date.now() / 1000) },
        echo: { title: 'title', description: 'description', stackId: 'stackId', duedate: 'duedate' },
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
        shape: { tableId: 'integer', count: 'integer', columns: 'array of { id, title, type, subtype, mandatory, selectionOptions (selection columns: [{ id, label }]), numberDecimals (number columns) }' },
        sample: { tableId: 4, count: 2, columns: [{ id: 1, title: 'Datum', type: 'datetime', subtype: 'date', mandatory: false }, { id: 2, title: 'Leverancier', type: 'text', subtype: 'line', mandatory: false }] },
        echo: { tableId: 'tableId' },
    },
    nextcloud_tables_create: {
        shape: { success: 'boolean', table: 'object { id, title, emoji, ownership, isShared, archived, rowsCount, columnsCount }' },
        sample: { success: true, table: { id: 7, title: 'Facturen', emoji: '🧾', ownership: 'admin', isShared: false, archived: false, rowsCount: 0, columnsCount: 0 } },
        echo: { 'table.title': 'title', 'table.emoji': 'emoji' },
    },
    nextcloud_tables_create_row: {
        shape: { success: 'boolean', row: 'object { id, tableId, createdBy, createdAt, values }', warnings: 'array of string|undefined (e.g. a number was rounded)' },
        sample: { success: true, row: { id: 31, tableId: 4, createdBy: 'admin', createdAt: '2026-09-12 10:00:00', values: { Datum: '2026-09-19', Leverancier: 'Noordlicht Energie B.V.', Totaal: 1554.25 } } },
    },
    nextcloud_tables_update_row: {
        shape: { success: 'boolean', row: 'object { id, tableId, lastEditBy, lastEditAt, values }', warnings: 'array of string|undefined (e.g. a number was rounded)' },
        sample: { success: true, row: { id: 31, tableId: 4, lastEditBy: 'admin', lastEditAt: '2026-09-12 10:05:00', values: { Totaal: 1554.25 } }, warnings: [] },
    },

    nextcloud_list_files: {
        // fileOperations.js returns { path, count, items } — the array is
        // `items`, NOT `files` or `results`. Without this entry inspect said
        // "no declared output schema" and three measured builds guessed three
        // different names, each costing a dry-run round; one shipped a forEach
        // over `.files`, a field that does not exist. Read off the executor.
        shape: { path: 'string', count: 'integer', items: 'array of { name, path, type ("file"|"folder"), size, contentType, modified, fileId }' },
        sample: { path: '/Invoices', count: 1, items: [{ name: 'Invoice-2026-001.pdf', path: '/Invoices/Invoice-2026-001.pdf', type: 'file', size: 51200, contentType: 'application/pdf', modified: 'Thu, 10 Sep 2026 09:00:00 GMT', fileId: '1234' }] },
        echo: { path: 'path' },
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
        echo: { path: 'path' },
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
        // No stacks here: the handler maps each board to these fields only.
        // A board's columns come from nextcloud_deck_list_stacks.
        shape: { count: 'integer', boards: 'array of { id, title, color, archived, labels: [{ id, title, color }], permissions, owner }' },
        sample: { count: 1, boards: [{ id: 2, title: 'Demo Ops', color: '0082c9', archived: false, labels: [{ id: 1, title: 'Urgent', color: 'ff0000' }], permissions: { PERMISSION_READ: true, PERMISSION_EDIT: true, PERMISSION_MANAGE: true, PERMISSION_SHARE: true }, owner: 'alice' }] },
    },
    nextcloud_deck_list_stacks: {
        shape: { boardId: 'integer', count: 'integer', stacks: 'array of { id, title, order, cardCount }' },
        sample: { boardId: 2, count: 2, stacks: [{ id: 5, title: 'Inbox', order: 0, cardCount: 3 }, { id: 6, title: 'Done', order: 1, cardCount: 7 }] },
        echo: { boardId: 'boardId' },
    },

    // ── GitHub writes ─────────────────────────────────────────────
    github_create_repo: {
        shape: { id: 'integer', name: 'string', fullName: 'string', htmlUrl: 'string', private: 'boolean' },
        sample: { id: 1, name: 'new-repo', fullName: 'org/new-repo', htmlUrl: 'https://github.com/org/new-repo', private: false },
    },

    // ── Scaleway Billing (read-only) ──────────────────────────────
    // integrations/scalewayBillingTools.js. The list is under `invoices`, so
    // a forEach binds overRef: "steps.<id>.output.invoices". The download
    // keeps the PDF for the run and hands on a generated_file handle, the
    // same one generate_document produces.
    scaleway_list_invoices: {
        shape: {
            invoices: 'array of { id, number, billingPeriod (YYYY-MM), issuedDate, dueDate, type (periodic|purchase|credit_note), state, currency, totalExclVat, totalVat, totalInclVat, fileName }',
            count: 'integer (invoices returned)',
            total: 'integer (invoices matching the period window)',
        },
        sample: {
            invoices: [
                { id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', number: 1234567, billingPeriod: '2026-09', issuedDate: '2026-10-01', dueDate: '2026-10-31', type: 'periodic', state: 'paid', currency: 'EUR', totalExclVat: 123.45, totalVat: 25.92, totalInclVat: 149.37, fileName: 'Scaleway-2026-09-1234567.pdf' },
            ],
            count: 1,
            total: 1,
        },
    },
    scaleway_download_invoice: {
        shape: {
            fileId: 'string', filename: 'string', mimeType: 'string (application/pdf)', size: 'integer (bytes)',
            invoiceNumber: 'integer', billingPeriod: 'string (YYYY-MM)',
            sourceHandle: 'opaque { kind: "generated_file", fileId } — pass to drive_upload_file / nextcloud_upload_file to save the PDF',
        },
        sample: {
            fileId: 'gen-file-1', filename: 'Scaleway-2026-09-1234567.pdf', mimeType: 'application/pdf', size: 48213,
            invoiceNumber: 1234567, billingPeriod: '2026-09',
            sourceHandle: { kind: 'generated_file', fileId: 'gen-file-1' },
        },
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

module.exports = { OUTPUT_SCHEMAS_PART_2 };
