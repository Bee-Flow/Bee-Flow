/**
 * The step catalog as rows: [kind, group, icon, English name, English blurb,
 * flag]. stepCatalog.ts turns each row into a StepMeta with Msg keys
 * `studio_apps_edit.step_catalog.<kind>_label|_blurb`, the web's. The order is the web's
 * (flow/stepCatalog.js), which is the palette order.
 */

export type StepGroupId = 'On screen' | 'Data' | 'AI' | 'Flow';
export type StepRow = readonly [
    kind: string,
    group: StepGroupId,
    icon: string,
    label: string,
    blurb: string,
    flag?: 'server' | 'container',
];

const SCREEN = 'On screen';

export const STEP_ROWS: readonly StepRow[] = [
    // On screen
    ['navigate', SCREEN, 'ArrowRight', 'Go to screen', 'Open another screen in this app.'],
    ['toast', SCREEN, 'MessageSquare', 'Show a message', 'A short confirmation or warning.'],
    ['open_url', SCREEN, 'ExternalLink', 'Open a web page', 'Send the person to an address outside the app.'],
    ['open_modal', SCREEN, 'SquareStack', 'Open a dialog', 'Show one of this screen’s dialogs.'],
    ['close_modal', SCREEN, 'SquareStack', 'Close a dialog', 'Put a dialog away — end a save flow with this.'],
    ['confirm', SCREEN, 'CircleCheck', 'Ask first', 'Stop and ask. Declining cancels everything after it.'],
    ['reset_form', SCREEN, 'RefreshCw', 'Clear a form', 'Empty a form’s fields back to their defaults, by form name.'],
    ['download_file', SCREEN, 'Download', 'Download a file', 'Save a file straight to the person’s computer.'],
    ['refresh', SCREEN, 'RefreshCw', 'Reload the data', 'Fetch the rows again after something changed.'],
    ['set_variable', SCREEN, 'Braces', 'Set a variable', 'Put a value in one of the app’s shared variables.'],
    // Data
    ['create_record', 'Data', 'Database', 'Add a row', 'Write a new row into one of this app’s tables.', 'server'],
    ['update_record', 'Data', 'Pencil', 'Change a row', 'Update an existing row.', 'server'],
    ['delete_record', 'Data', 'Trash2', 'Delete a row', 'Remove a row for good.', 'server'],
    ['run_automation', 'Data', 'Workflow', 'Run an automation', 'Hand the work to one of your automations.', 'server'],
    [
        'request_approval', 'Data', 'BadgeCheck', 'Ask for approval',
        'Put a question in someone’s Approvals inbox; a record can flip when they decide.', 'server',
    ],
    ['send_email', 'Data', 'Mail', 'Send an email', 'Send a message from the app owner’s mailbox.', 'server'],
    ['generate_file', 'Data', 'FileDown', 'Make a file', 'Turn rows into a CSV or spreadsheet people can download.', 'server'],
    [
        'fill_document', 'Data', 'FilePenLine', 'Fill a document',
        'Fill an invoice, quote, letter or presentation you designed in Studio → Documents and keep the PDF (a presentation: the .pptx).',
        'server',
    ],
    [
        'generate_presentation', 'Data', 'Presentation', 'Make a presentation',
        'Turn an AI-written outline or rows with a title and content into a PowerPoint (or PDF deck) in your house style.',
        'server',
    ],
    [
        'redact_pdf', 'Data', 'Eraser', 'Clean a PDF',
        'Remove names, initials, contact details and the customer’s logo from a PDF and keep the rest exactly as it was.',
        'server',
    ],
    [
        'file_intake', 'Data', 'Inbox', 'File the attachments',
        'Store a conversation’s mailed files and pair drawings with their CAD files.', 'server',
    ],
    [
        'dataset_query', 'Data', 'Dna', 'Query a dataset',
        'Read a bounded slice out of a large genome file — by gene, region or rsID.', 'server',
    ],
    // AI
    [
        'ai_browse', 'AI', 'Globe', 'Browse the web',
        'An AI agent opens live web pages; a Live browser component shows what it does. Needs AI browsing enabled in App settings.',
        'server',
    ],
    ['ai_extract', 'AI', 'FileSearch', 'Read a document', 'Pull structured fields out of an uploaded file.', 'server'],
    ['ai_generate', 'AI', 'Bot', 'Write something', 'Draft or summarise text.', 'server'],
    ['kb_query', 'AI', 'Search', 'Search the knowledge base', 'Look something up in a knowledge base.', 'server'],
    // Flow
    ['condition', 'Flow', 'GitBranch', 'If…', 'Take one path or the other.', 'container'],
    ['switch', 'Flow', 'Layers', 'Depending on…', 'Several paths, one per case.', 'container'],
    ['loop', 'Flow', 'Repeat', 'For each', 'Do the same thing for every row in a list.', 'container'],
];
