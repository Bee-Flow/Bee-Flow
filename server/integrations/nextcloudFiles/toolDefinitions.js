/**
 * Tool definitions for the Nextcloud file tools — the schemas the model sees
 * for files, sharing, comments, tags, trash and versions.
 */

const { DECK_INPUT_PROPERTIES } = require('../../core/documents/deckModel');
const { DECK_THEME_INPUT_SCHEMA } = require('../../core/documents/deckThemeOptions');

const NEXTCLOUD_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_files',
            description: 'List files and folders in a Nextcloud directory. Returns name, type (file/folder), size, and last-modified date. Use path "/" for the root of the user\'s files.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path relative to the user\'s files root (e.g. "/", "/Documents", "/Photos/2024").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_search_files',
            description: 'Search for files and folders by name in the user\'s Nextcloud. Matches partial names case-insensitively.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (matched against file/folder names).' },
                    limit: { type: 'integer', description: 'Maximum number of results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_read_file',
            description: 'Read the contents of a file from Nextcloud. Handles plain text, PDFs (text layer plus Azure / Mistral OCR fallback), DOCX, PPTX (slide text + speaker notes, one section per slide) and XLSX/CSV — the same extraction pipeline used when a user uploads a file directly to chat. Extracted text larger than ~200 KB is truncated.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Full path to the file (e.g. "/Documents/notes.md", "/Invoices/2026/invoice.pdf").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_upload_file',
            description: 'Upload or overwrite a file in Nextcloud. Two content sources:\n'
                + '  1) sourceHandle — opaque handle from another tool (e.g. the `sourceHandle` returned by gmail_read_attachment) pointing at bytes the server already has. PREFERRED for attachments and any binary: no base64 ever passes through the AI context.\n'
                + '  2) content — inline text, or base64 when isBase64 is true.\n'
                + 'Parent folders must already exist (create them with nextcloud_create_folder).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Destination file path (e.g. "/Documents/draft.md").' },
                    content: { type: 'string', description: 'Inline content. Mutually exclusive with sourceHandle. UTF-8 text, or base64 when isBase64 is true.' },
                    isBase64: { type: 'boolean', description: 'Treat `content` as base64. Use sourceHandle instead where possible.' },
                    sourceHandle: {
                        type: 'object',
                        description: 'Opaque handle from another tool. Mutually exclusive with content. { kind: "gmail_attachment", messageId, attachmentId } for a mail attachment; inside an automation { kind: "generated_file", fileId } for the file a generate_document / fill_document / presentation step kept — bind the whole handle: sourceHandle:{kind:"ref",path:"steps.<id>.output.sourceHandle"}. A `path` ending in "/" takes the file\'s own name.',
                        properties: {
                            kind: { type: 'string', description: 'Handle kind: "gmail_attachment" or "generated_file".' },
                            messageId: { type: 'string' },
                            attachmentId: { type: 'string' },
                            fileId: { type: 'string', description: 'For kind "generated_file": the fileId a document or presentation step produced.' },
                            mimeType: { type: 'string' }
                        }
                    },
                    contentType: { type: 'string', description: 'MIME type. Inferred from sourceHandle.mimeType or the filename extension when omitted.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_spreadsheet',
            description: 'Create a REAL spreadsheet file (.xlsx or .ods) from row data and save it to Nextcloud — it opens directly in Nextcloud Office / Excel, unlike a CSV. Missing parent folders are created automatically. If a file already exists at `path`: with the default ifExists:"overwrite" it is REPLACED by a fresh file holding only `rows`; with ifExists:"append" the new rows are ADDED below the existing ones, matched to the existing header by column name (new keys become new columns) — use "append" for a running ledger (invoices, log lines) that grows over runs. Appending to a file that is not a spreadsheet fails instead of overwriting it.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Destination path including filename, e.g. "/Reports/invoices.xlsx". The extension sets the format unless `format` is given.' },
                    rows: { type: 'array', description: 'The table data: an array of row OBJECTS (each key is a column), e.g. [{"Invoice":"202600117","Amount":47.87,"Status":"unpaid"}]. The first row\'s keys become the header/column order. (An array of arrays of raw cell values is also accepted.)', items: { type: 'object' } },
                    columns: { type: 'array', description: 'Optional explicit column order / header labels. Defaults to the keys of the first row.', items: { type: 'string' } },
                    sheetName: { type: 'string', description: 'Worksheet (tab) name. Default "Sheet1".' },
                    format: { type: 'string', enum: ['xlsx', 'ods'], description: 'Spreadsheet format. Defaults from the file extension, otherwise xlsx.' },
                    ifExists: { type: 'string', enum: ['overwrite', 'append'], description: 'What to do when a file already exists at `path`. "overwrite" (default): replace it with a fresh file holding only `rows`. "append": download it, add `rows` below the last row of the sheet named `sheetName` (or the first sheet), and save it back — other sheets are kept. Object rows are mapped onto the existing header by column name; keys the header lacks are added as new columns. When no file exists yet, "append" creates it like "overwrite". The result then carries `appended` (number of rows added; 0 when the file was newly created).' }
                },
                required: ['path', 'rows']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_document',
            description: 'Create a REAL word-processor document (.docx or .odt) from text/Markdown and save it to Nextcloud — opens in Nextcloud Office / Word. Supports "# / ## / ###" headings and "- " bullet lists. Missing parent folders are created automatically.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Destination path including filename, e.g. "/Reports/summary.docx". The extension sets the format unless `format` is given.' },
                    content: { type: 'string', description: 'Document body as plain text or light Markdown (# / ## / ### headings, "- " bullets, blank line = new paragraph).' },
                    title: { type: 'string', description: 'Optional document title rendered at the top.' },
                    format: { type: 'string', enum: ['docx', 'odt'], description: 'Document format. Defaults from the file extension, otherwise docx.' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_presentation',
            description: 'Create a REAL presentation (.pptx) in the organisation\'s house style and save it to Nextcloud — it opens in Nextcloud Office (Impress) and PowerPoint. Same content rules as create_presentation: give `slides` (structured, 3–6 bullets per slide plus speaker notes) or `markdown` ("# " title once, "## " per slide, "- " bullets, "> " quote, a "|" table, "<!-- notes: … -->"). Missing parent folders are created automatically. Returns { path, fileId, webUrl } — give the user the webUrl as "Open in Nextcloud Office". Images: only a Bee Flow storage URL (e.g. the imageUrl from generate_image) or a data: URL; remote pictures are not fetched. Slides may carry a `chart`, `stats` (KPI tiles), `steps` (timeline) or `style:"accent"`; `theme` sets another look only when asked.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Destination path including filename, e.g. "/Presentations/q3-review.pptx". ".pptx" is appended when missing.' },
                    ...DECK_INPUT_PROPERTIES,
                    templatePath: { type: 'string', description: 'Optional: a .pptx in Nextcloud whose first two slides carry a design (a conference or client template) — the deck is built on its backgrounds and logo.' },
                    houseStyle: { type: 'boolean', description: "Defaults to TRUE — the organisation's colours, font, logo and footer. Pass false ONLY when the user explicitly asks for another brand or an unbranded deck." },
                    saveToLibrary: { type: 'boolean', description: 'Defaults to TRUE: the deck is also kept in Studio → Documents as an editable presentation (the result has documentUrl, which opens the slides in Bee Flow).' },
                    theme: DECK_THEME_INPUT_SCHEMA
                },
                required: ['path', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_search',
            description: 'Search across EVERYTHING in Nextcloud at once — files, Talk messages, calendar events, contacts, Deck cards, Mail, and any other app that registers a search provider. Prefer this over nextcloud_search_files when the user has not said where to look, or when a new Nextcloud app might hold the answer.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for.' },
                    providers: { type: 'array', items: { type: 'string' }, description: 'Optional list of provider ids to restrict to (from a previous call\'s `availableProviders`). Omit to search everything.' },
                    limit: { type: 'integer', description: 'Max results per provider (default 5, max 20).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_groups',
            description: 'List the Nextcloud user groups on this instance. Needed before sharing with a group — nextcloud_share_with_group takes a group id, not a display name.',
            parameters: {
                type: 'object',
                properties: {
                    search: { type: 'string', description: 'Optional substring to filter group ids by.' },
                    limit: { type: 'integer', description: 'Max groups (default 100, max 500).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_convert_file',
            description: 'Convert a file to another format using Nextcloud Office — e.g. docx/odt → pdf, xlsx → pdf, pptx → pdf. Requires the Nextcloud Office (richdocuments) app. Returns the path of the converted file.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer', description: 'Numeric file id of the source file (from list_files, search_files, or a file trigger).' },
                    targetMimeType: { type: 'string', description: 'MIME type to convert to, e.g. "application/pdf". Defaults to application/pdf.' },
                    destination: { type: 'string', description: 'Optional destination path for the converted file (e.g. "/Invoices/invoice.pdf"). Defaults to alongside the source file.' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_folder_tree',
            description: 'Get a nested tree of the user\'s folders in one call — much cheaper than walking list_files level by level when you need an overview of where things live.',
            parameters: {
                type: 'object',
                properties: {
                    depth: { type: 'integer', description: 'How many levels deep to descend (default 3, max 10).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_direct_link',
            description: 'Mint a short-lived direct download URL for a file. Use this instead of reading a large or binary file into the conversation — the URL can be handed to another step or service.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer', description: 'Numeric file id of the file to link.' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_folder',
            description: 'Create a new folder in Nextcloud. Parent folders must already exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Folder path to create (e.g. "/Projects/2026").' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_delete',
            description: 'Delete a file or folder from Nextcloud (moves it to the trash).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder to delete.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_move',
            description: 'Move or rename a file or folder in Nextcloud (server-side WebDAV MOVE — no download/re-upload). Works for both files and folders. Renaming is just moving to the same parent with a new filename. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Current path (e.g. "/Invoices/foo.pdf").' },
                    destination: { type: 'string', description: 'Target path (e.g. "/Invoices/2026-01/foo.pdf"). Parent folders must already exist.' },
                    overwrite: { type: 'boolean', description: 'If true, overwrite an existing file at the destination. Default false (fails with 412 if target exists).' }
                },
                required: ['source', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_copy',
            description: 'Copy a file or folder in Nextcloud (server-side WebDAV COPY — no download/re-upload). Works for both files and folders. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Source path (e.g. "/Documents/template.docx").' },
                    destination: { type: 'string', description: 'Target path. Parent folders must already exist.' },
                    overwrite: { type: 'boolean', description: 'If true, overwrite an existing file at the destination. Default false.' }
                },
                required: ['source', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_share',
            description: 'Create a public share link for a file or folder. Returns the share URL. Permissions default to read-only.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder to share.' },
                    password: { type: 'string', description: 'Optional password to protect the share link.' },
                    expireDate: { type: 'string', description: 'Optional expiration date in YYYY-MM-DD format.' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_with_user',
            description: 'Share a file or folder with a specific Nextcloud user. The user has approved this. permissions: 1=read, 2=update, 4=create, 8=delete, 16=share — combine with bitwise OR (e.g. 31 = full).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder.' },
                    shareWith: { type: 'string', description: 'Target user uid.' },
                    permissions: { type: 'integer', description: 'Permission bitmask, default 1 (read).' },
                    expireDate: { type: 'string', description: 'Optional YYYY-MM-DD.' },
                    note: { type: 'string', description: 'Optional note shown to the recipient.' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_with_group',
            description: 'Share a file or folder with a Nextcloud group. The user has approved this. permissions bitmask same as share_with_user (1=read, 2=update, 4=create, 8=delete, 16=share).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    shareWith: { type: 'string', description: 'Target group id.' },
                    permissions: { type: 'integer', description: 'Permission bitmask, default 1 (read).' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_by_email',
            description: 'Share a file or folder by email (creates a hidden public link emailed to the recipient). The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    shareWith: { type: 'string', description: 'Recipient email address.' },
                    password: { type: 'string', description: 'Optional access password.' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['path', 'shareWith']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_shares',
            description: 'List shares. Defaults to outgoing shares. Pass shared_with_me=true for incoming, or path=… for shares of a specific path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Optional path filter — list shares for this exact file/folder.' },
                    shared_with_me: { type: 'boolean', description: 'true = shares shared with the user (incoming).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_update_share',
            description: 'Update an existing share — change permissions, password, expiry, or note. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    shareId: { type: 'integer' },
                    permissions: { type: 'integer' },
                    password: { type: 'string', description: 'New password (empty string clears).' },
                    expireDate: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['shareId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_delete_share',
            description: 'Revoke a share by id. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    shareId: { type: 'integer' }
                },
                required: ['shareId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_file_comments',
            description: 'List comments on a file. fileId is the numeric id (from nextcloud_list_files).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max comments (default 50, max 200).' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_add_file_comment',
            description: 'Add a comment to a file. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    message: { type: 'string', description: 'Plain-text comment body.' }
                },
                required: ['fileId', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_tags',
            description: 'List system tags available on this Nextcloud (id, name, visibility, assignable flag).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_create_tag',
            description: 'Create a new system tag. The user has approved this. Most servers require admin rights for visible tags.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    userVisible: { type: 'boolean', description: 'Visible to all users (default true).' },
                    userAssignable: { type: 'boolean', description: 'Assignable by all users (default true).' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tag_file',
            description: 'Attach a system tag to a file or folder.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    tagId: { type: 'integer' }
                },
                required: ['fileId', 'tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_untag_file',
            description: 'Remove a system tag from a file.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    tagId: { type: 'integer' }
                },
                required: ['fileId', 'tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_find_files_by_tag',
            description: 'Find all files and folders that carry a given system tag.',
            parameters: {
                type: 'object',
                properties: {
                    tagId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max results (default 100, max 500).' }
                },
                required: ['tagId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_trash',
            description: 'List items in the user\'s Nextcloud trash bin (deleted files awaiting permanent removal).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', description: 'Max items (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_restore_from_trash',
            description: 'Restore a single item from the trash to its original location. Use the trashPath returned by list_trash.',
            parameters: {
                type: 'object',
                properties: {
                    trashPath: { type: 'string', description: 'Trash item path (from list_trash).' },
                    originalPath: { type: 'string', description: 'Optional override for the destination — defaults to the original location.' }
                },
                required: ['trashPath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_permanent_delete_trash',
            description: 'Permanently remove an item from the trash bin. Always confirm with the user before calling — this is unrecoverable.',
            parameters: {
                type: 'object',
                properties: {
                    trashPath: { type: 'string', description: 'Trash item path (from list_trash).' }
                },
                required: ['trashPath']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_versions',
            description: 'List previous versions of a file (by fileId).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_restore_version',
            description: 'Restore a previous version of a file. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer' },
                    versionId: { type: 'string', description: 'Version id (from list_versions).' }
                },
                required: ['fileId', 'versionId']
            }
        }
    }
];

module.exports = { NEXTCLOUD_TOOLS };
