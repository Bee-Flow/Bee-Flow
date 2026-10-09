import {
    ArrowRight, BadgeCheck, Bell, Bot, Braces, CheckCircle2, Database, Dna, Download, Eraser, ExternalLink, FileDown, FileSignature,
    FileSearch, GitBranch, Globe, Inbox, Layers, Mail, MessageSquare, Pencil, Presentation, RefreshCw,
    Repeat, Search, SquareStack, Trash2, Workflow,
} from 'lucide-react';

/**
 * How each step KIND presents itself: a human name, an icon, a group, and the
 * one line that says what it does. Grouped the way somebody thinks about it —
 * "what happens on screen", "what changes in the data", "what decides" — not by
 * whether the browser or the server runs it.
 *
 * The kinds themselves come from the server (STEP_KINDS); this only dresses
 * them. stepCatalog.lockstep.test.js fails if a kind ships without an entry, so
 * a new step type cannot land as an unlabelled grey box.
 */

export const STEP_GROUPS = ['On screen', 'Data', 'AI', 'Flow'];

/** group id → [key, English]; the id itself stays English (the catalog and its tests key on it). */
const GROUP_LABELS = {
    'On screen': ['studio_apps_edit.step_catalog.group_on_screen', 'On screen'],
    Data: ['studio_apps_edit.step_catalog.group_data', 'Data'],
    AI: ['studio_apps_edit.step_catalog.group_ai', 'AI'],
    Flow: ['studio_apps_edit.step_catalog.group_flow', 'Flow'],
};

/** The group's name for display. */
export function groupLabel(group, t = null) {
    const entry = GROUP_LABELS[group];
    if (!entry) return group;
    return t ? t(entry[0], entry[1]) : entry[1];
}

export const STEP_CATALOG = {
    // ── On screen ───────────────────────────────────────────────────────────
    navigate: {
        label: 'Go to screen', labelKey: 'studio_apps_edit.step_catalog.navigate_label', group: 'On screen', icon: ArrowRight,
        blurb: 'Open another screen in this app.',
        blurbKey: 'studio_apps_edit.step_catalog.navigate_blurb',
    },
    toast: {
        label: 'Show a message', labelKey: 'studio_apps_edit.step_catalog.toast_label', group: 'On screen', icon: MessageSquare,
        blurb: 'A short confirmation or warning.',
        blurbKey: 'studio_apps_edit.step_catalog.toast_blurb',
    },
    open_url: {
        label: 'Open a web page', labelKey: 'studio_apps_edit.step_catalog.open_url_label', group: 'On screen', icon: ExternalLink,
        blurb: 'Send the person to an address outside the app.',
        blurbKey: 'studio_apps_edit.step_catalog.open_url_blurb',
    },
    open_modal: {
        label: 'Open a dialog', labelKey: 'studio_apps_edit.step_catalog.open_modal_label', group: 'On screen', icon: SquareStack,
        blurb: 'Show one of this screen’s dialogs.',
        blurbKey: 'studio_apps_edit.step_catalog.open_modal_blurb',
    },
    close_modal: {
        label: 'Close a dialog', labelKey: 'studio_apps_edit.step_catalog.close_modal_label', group: 'On screen', icon: SquareStack,
        blurb: 'Put a dialog away — end a save flow with this.',
        blurbKey: 'studio_apps_edit.step_catalog.close_modal_blurb',
    },
    confirm: {
        label: 'Ask first', labelKey: 'studio_apps_edit.step_catalog.confirm_label', group: 'On screen', icon: CheckCircle2,
        blurb: 'Stop and ask. Declining cancels everything after it.',
        blurbKey: 'studio_apps_edit.step_catalog.confirm_blurb',
    },
    reset_form: {
        label: 'Clear a form', labelKey: 'studio_apps_edit.step_catalog.reset_form_label', group: 'On screen', icon: RefreshCw,
        blurb: 'Empty a form’s fields back to their defaults, by form name.',
        blurbKey: 'studio_apps_edit.step_catalog.reset_form_blurb',
    },
    // 'On screen' rather than 'Data': nothing is stored or changed, the
    // browser just hands the person a file it already has. Pairs with
    // "Make a file", which produces the thing this saves.
    download_file: {
        label: 'Download a file', labelKey: 'studio_apps_edit.step_catalog.download_file_label', group: 'On screen', icon: Download,
        blurb: 'Save a file straight to the person’s computer.',
        blurbKey: 'studio_apps_edit.step_catalog.download_file_blurb',
    },
    refresh: {
        label: 'Reload the data', labelKey: 'studio_apps_edit.step_catalog.refresh_label', group: 'On screen', icon: RefreshCw,
        blurb: 'Fetch the rows again after something changed.',
        blurbKey: 'studio_apps_edit.step_catalog.refresh_blurb',
    },
    set_variable: {
        label: 'Set a variable', labelKey: 'studio_apps_edit.step_catalog.set_variable_label', group: 'On screen', icon: Braces,
        blurb: 'Put a value in one of the app’s shared variables.',
        blurbKey: 'studio_apps_edit.step_catalog.set_variable_blurb',
    },

    // ── Data ────────────────────────────────────────────────────────────────
    create_record: {
        label: 'Add a row', labelKey: 'studio_apps_edit.step_catalog.create_record_label', group: 'Data', icon: Database, server: true,
        blurb: 'Write a new row into one of this app’s tables.',
        blurbKey: 'studio_apps_edit.step_catalog.create_record_blurb',
    },
    update_record: {
        label: 'Change a row', labelKey: 'studio_apps_edit.step_catalog.update_record_label', group: 'Data', icon: Pencil, server: true,
        blurb: 'Update an existing row.',
        blurbKey: 'studio_apps_edit.step_catalog.update_record_blurb',
    },
    delete_record: {
        label: 'Delete a row', labelKey: 'studio_apps_edit.step_catalog.delete_record_label', group: 'Data', icon: Trash2, server: true,
        blurb: 'Remove a row for good.',
        blurbKey: 'studio_apps_edit.step_catalog.delete_record_blurb',
    },
    run_automation: {
        label: 'Run an automation', labelKey: 'studio_apps_edit.step_catalog.run_automation_label', group: 'Data', icon: Workflow, server: true,
        blurb: 'Hand the work to one of your automations.',
        blurbKey: 'studio_apps_edit.step_catalog.run_automation_blurb',
    },
    request_approval: {
        label: 'Ask for approval', labelKey: 'studio_apps_edit.step_catalog.request_approval_label', group: 'Data', icon: BadgeCheck, server: true,
        blurb: 'Put a question in someone’s Approvals inbox; a record can flip when they decide.',
        blurbKey: 'studio_apps_edit.step_catalog.request_approval_blurb',
    },
    send_email: {
        label: 'Send an email', labelKey: 'studio_apps_edit.step_catalog.send_email_label', group: 'Data', icon: Mail, server: true,
        blurb: 'Send a message from the app owner’s mailbox.',
        blurbKey: 'studio_apps_edit.step_catalog.send_email_blurb',
    },
    generate_file: {
        label: 'Make a file', labelKey: 'studio_apps_edit.step_catalog.generate_file_label', group: 'Data', icon: FileDown, server: true,
        blurb: 'Turn rows into a CSV or spreadsheet people can download.',
        blurbKey: 'studio_apps_edit.step_catalog.generate_file_blurb',
    },
    fill_document: {
        label: 'Fill a document', labelKey: 'studio_apps_edit.step_catalog.fill_document_label', group: 'Data', icon: FileSignature, server: true,
        blurb: 'Fill an invoice, quote, letter or presentation you designed in Studio → Documents and keep the PDF (a presentation: the .pptx).',
        blurbKey: 'studio_apps_edit.step_catalog.fill_document_blurb',
    },
    generate_presentation: {
        label: 'Make a presentation', labelKey: 'studio_apps_edit.step_catalog.generate_presentation_label', group: 'Data', icon: Presentation, server: true,
        blurb: 'Turn an AI-written outline or rows with a title and content into a PowerPoint (or PDF deck) in your house style.',
        blurbKey: 'studio_apps_edit.step_catalog.generate_presentation_blurb',
    },
    redact_pdf: {
        label: 'Clean a PDF', labelKey: 'studio_apps_edit.step_catalog.redact_pdf_label', group: 'Data', icon: Eraser, server: true,
        blurb: 'Remove names, initials, contact details and the customer’s logo from a PDF and keep the rest exactly as it was.',
        blurbKey: 'studio_apps_edit.step_catalog.redact_pdf_blurb',
    },
    file_intake: {
        label: 'File the attachments', labelKey: 'studio_apps_edit.step_catalog.file_intake_label', group: 'Data', icon: Inbox, server: true,
        blurb: 'Store a conversation’s mailed files and pair drawings with their CAD files.',
        blurbKey: 'studio_apps_edit.step_catalog.file_intake_blurb',
    },
    dataset_query: {
        label: 'Query a dataset', labelKey: 'studio_apps_edit.step_catalog.dataset_query_label', group: 'Data', icon: Dna, server: true,
        blurb: 'Read a bounded slice out of a large genome file — by gene, region or rsID.',
        blurbKey: 'studio_apps_edit.step_catalog.dataset_query_blurb',
    },

    // ── AI ──────────────────────────────────────────────────────────────────
    ai_browse: {
        label: 'Browse the web', labelKey: 'studio_apps_edit.step_catalog.ai_browse_label', group: 'AI', icon: Globe, server: true,
        blurb: 'An AI agent opens live web pages; a Live browser component shows what it does. Needs AI browsing enabled in App settings.',
        blurbKey: 'studio_apps_edit.step_catalog.ai_browse_blurb',
    },
    ai_extract: {
        label: 'Read a document', labelKey: 'studio_apps_edit.step_catalog.ai_extract_label', group: 'AI', icon: FileSearch, server: true,
        blurb: 'Pull structured fields out of an uploaded file.',
        blurbKey: 'studio_apps_edit.step_catalog.ai_extract_blurb',
    },
    ai_generate: {
        label: 'Write something', labelKey: 'studio_apps_edit.step_catalog.ai_generate_label', group: 'AI', icon: Bot, server: true,
        blurb: 'Draft or summarise text.',
        blurbKey: 'studio_apps_edit.step_catalog.ai_generate_blurb',
    },
    kb_query: {
        label: 'Search the knowledge base', labelKey: 'studio_apps_edit.step_catalog.kb_query_label', group: 'AI', icon: Search, server: true,
        blurb: 'Look something up in a knowledge base.',
        blurbKey: 'studio_apps_edit.step_catalog.kb_query_blurb',
    },

    // ── Flow ────────────────────────────────────────────────────────────────
    condition: {
        label: 'If…', labelKey: 'studio_apps_edit.step_catalog.condition_label', group: 'Flow', icon: GitBranch, container: true,
        blurb: 'Take one path or the other.',
        blurbKey: 'studio_apps_edit.step_catalog.condition_blurb',
    },
    switch: {
        label: 'Depending on…', labelKey: 'studio_apps_edit.step_catalog.switch_label', group: 'Flow', icon: Layers, container: true,
        blurb: 'Several paths, one per case.',
        blurbKey: 'studio_apps_edit.step_catalog.switch_blurb',
    },
    loop: {
        label: 'For each', labelKey: 'studio_apps_edit.step_catalog.loop_label', group: 'Flow', icon: Repeat, container: true,
        blurb: 'Do the same thing for every row in a list.',
        blurbKey: 'studio_apps_edit.step_catalog.loop_blurb',
    },
};

/** Fallback presentation, so an unknown kind is still readable. */
export const UNKNOWN_STEP = { label: 'Step', group: 'Flow', icon: Bell, blurb: '' };

/**
 * The presentation for a kind. With `t`, label and blurb come back translated
 * (the entries carry their keys); without it, the English as written.
 */
export function stepMeta(kind, t = null) {
    const meta = STEP_CATALOG[kind];
    if (!meta) {
        return {
            ...UNKNOWN_STEP,
            label: String(kind || '').replace(/_/g, ' ') || (t ? t('studio_apps_edit.step_catalog.unknown_step', 'Step') : UNKNOWN_STEP.label),
        };
    }
    if (!t) return meta;
    return { ...meta, label: t(meta.labelKey, meta.label), blurb: t(meta.blurbKey, meta.blurb) };
}

/** The palette, grouped and in a fixed order. */
export function paletteGroups(t = null) {
    return STEP_GROUPS.map((group) => ({
        group,
        label: groupLabel(group, t),
        kinds: Object.entries(STEP_CATALOG)
            .filter(([, meta]) => meta.group === group)
            .map(([kind]) => ({ kind, ...stepMeta(kind, t) })),
    })).filter((g) => g.kinds.length);
}

/**
 * A fresh step of this kind, filled in enough to be valid the moment it lands.
 * A step that arrives already failing validation makes the author fix a problem
 * they did not create.
 */
export function newStep(kind, { screenId = '', modalId = '', t = null } = {}) {
    switch (kind) {
        case 'navigate': return { kind, screenId };
        case 'toast': return { kind, message: '', tone: 'info' };
        case 'open_url': return { kind, url: '', newTab: true };
        case 'open_modal': return { kind, modalId };
        case 'close_modal': return { kind, modalId };
        case 'reset_form': return { kind, form: '' };
        case 'confirm': return { kind, message: t ? t('studio_apps_edit.step_catalog.confirm_default', 'Are you sure?') : 'Are you sure?' };
        case 'refresh': return { kind };
        case 'set_variable': return { kind, name: '', value: { kind: 'static', value: '' } };
        case 'create_record': return { kind, tableId: '', values: {} };
        case 'update_record': return { kind, tableId: '', recordId: { kind: 'static', value: '' }, values: {} };
        case 'delete_record': return { kind, tableId: '', recordId: { kind: 'static', value: '' } };
        case 'run_automation': return { kind, automationId: null };
        // The question is the one required field; everything else (questions,
        // assignee, deadline, the on-decided record write) is added as needed.
        case 'request_approval': return { kind, prompt: { kind: 'static', value: '' }, resultVar: 'approval' };
        // connectorId names the mailbox it sends from; there is no sensible
        // default, so it starts blank and the validator says which one to pick.
        case 'send_email': return {
            kind,
            connectorId: '',
            to: { kind: 'static', value: '' },
            subject: { kind: 'static', value: '' },
            body: { kind: 'static', value: '' },
        };
        case 'ai_extract': return { kind, source: { kind: 'static', value: '' }, schema: [{ name: 'field1', type: 'string', description: '', required: false }] };
        case 'ai_generate': return { kind, prompt: '', output: 'text', resultVar: 'result' };
        case 'kb_query': return { kind, query: { kind: 'static', value: '' }, knowledgeBaseIds: [], resultVar: 'results' };
        case 'generate_file': return { kind, rows: { kind: 'static', value: [] }, fileName: { kind: 'static', value: 'export.csv' }, format: 'csv', resultVar: 'file' };
        // documentId starts EMPTY: it names one of the owner's designs, and
        // guessing one would render the wrong artefact convincingly. The
        // resultVar matches generate_file's so the download step that follows
        // needs no rewiring when an author swaps one for the other.
        case 'fill_document': return { kind, documentId: '', values: {}, resultVar: 'file' };
        // Seeded to the variable "Write with AI" fills by default — an outline
        // in, a deck out is the pair these come in. The resultVar matches the
        // other file steps' so the download step that follows needs no rewiring.
        case 'generate_presentation': return { kind, slides: { kind: 'formula', expr: 'vars.result' }, format: 'pptx', houseStyle: true, resultVar: 'file' };
        // Seeded to an upload field called "file"; the cleaned copy lands where
        // the other file steps put theirs, so a download step needs no rewiring.
        case 'redact_pdf': return { kind, source: { kind: 'formula', expr: 'form.file' }, useAi: true, resultVar: 'file' };
        // Seeded to the variable "Make a file" writes by default, because that
        // is the pair these two almost always come in: generate, then hand it
        // over. fileName stays blank — the file already carries its own.
        case 'download_file': return { kind, file: { kind: 'formula', expr: 'vars.file' }, fileName: { kind: 'static', value: '' } };
        // connectorId names the mailbox, exactly as send_email: no sensible
        // default, so it starts blank and the validator says which one to pick.
        case 'file_intake': return { kind, connectorId: '', threadKey: { kind: 'static', value: '' }, resultVar: 'intake' };
        // Exactly one selector is legal; gene is the one people reach for
        // ("show my BRCA1"), so a fresh step starts with an empty gene binding.
        case 'dataset_query': return { kind, dataset: { kind: 'static', value: '' }, gene: { kind: 'static', value: '' }, resultVar: 'variants' };
        case 'ai_browse': return { kind, task: { kind: 'static', value: '' }, resultVar: 'browse' };
        case 'condition': return { kind, expr: '', then: [], else: [] };
        // A case is matched on `value` — canonicalize keeps { value, steps } and
        // drops anything else, and the runner compares against c.value. This
        // used to seed `{ name: 'first' }`, which was deleted on the first save,
        // so every hand-built switch fell through to "Otherwise" for ever.
        case 'switch': return { kind, expr: '', cases: [{ value: '', steps: [] }], default: [] };
        case 'loop': return { kind, source: { kind: 'static', value: [] }, itemVar: 'item', steps: [] };
        default: return { kind };
    }
}
