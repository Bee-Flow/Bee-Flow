import { bindingForField } from './aiFieldMatching';

/**
 * What an action can BE, in one table.
 *
 * The vocabulary used to live in three places that disagreed: ActionsSection's
 * KIND_OPTIONS (11 kinds), styleKnobMeta's ACTION_KINDS (7 — and neither the
 * comment nor the list matched the server), and the server's own ACTION_KINDS
 * (11, now 12). Three lists, no test between them, so a kind could exist on one
 * side only and the failure surfaced at a user: a button that saves and then
 * does nothing.
 *
 * This module is the client's single answer to "which kinds are there, what is
 * each one called, which editor renders it, and what does a fresh one look
 * like". `actionKinds.lockstep.test.js` pins it against
 * server/appStudio/componentSpecs.js in BOTH directions.
 *
 * The four PRIMARY kinds are the cards in "When clicked" (Studio artboard 1b).
 * Everything else lives under "All options" — offered, not hidden, because a
 * kind the editor does not offer is a kind only the AI builder can write.
 */

// ── The four the redesign puts on cards ─────────────────────────────────────
// Order is the artboard's, not the schema's: it reads as a sentence about what
// buttons usually do, most common first.
export const PRIMARY_KINDS = ['run_automation', 'navigate', 'create_record', 'toast'];

/**
 * Which editor renders a kind's fields.
 *
 *   'builtin'  — a hand-written editor in ActionsSection
 *   'ai'       — AiActionEditors
 *   'spec'     — flow/StepSettings, rendered straight from the server catalog
 *   'flow'     — the step canvas (a sequence is not a single thing)
 *
 * This is a lookup rather than a comment because the lockstep test reads it: a
 * kind with no editor is a kind that renders as an empty box, and the author
 * cannot tell that apart from "this one has no settings".
 */
export const EDITOR_BY_KIND = {
    run_automation: 'builtin',
    navigate: 'builtin',
    toast: 'builtin',
    open_url: 'builtin',
    ai_extract: 'ai',
    ai_generate: 'ai',
    kb_query: 'ai',
    send_email: 'spec',
    open_modal: 'spec',
    close_modal: 'spec',
    // Same treatment as send_email: the fields come from the server spec, so
    // the tableId picker and the column rows arrive without a bespoke editor
    // to keep in step with the schema.
    create_record: 'spec',
    sequence: 'flow',
};

/**
 * Every kind, in the order the "All options" select lists them.
 *
 * `labelEn` is the English the UI shows until the dictionary has the key — t()
 * returns its string fallback, so a key that has not landed yet reads correctly
 * rather than showing a raw `app_studio.…` id.
 */
export const KIND_OPTIONS = [
    { value: 'run_automation', labelKey: 'app_studio.inspector.kind_run_automation', labelEn: 'Run automation' },
    { value: 'ai_extract', labelKey: 'app_studio.inspector.kind_ai_extract', labelEn: 'AI · extract from document' },
    { value: 'ai_generate', labelKey: 'app_studio.inspector.kind_ai_generate', labelEn: 'AI · generate / summarize' },
    { value: 'kb_query', labelKey: 'app_studio.inspector.kind_kb_query', labelEn: 'AI · search knowledge base' },
    { value: 'create_record', labelKey: 'app_studio.inspector.kind_create_record', labelEn: 'Add a row' },
    { value: 'navigate', labelKey: 'app_studio.inspector.kind_navigate', labelEn: 'Go to screen' },
    { value: 'toast', labelKey: 'app_studio.inspector.kind_toast', labelEn: 'Show a message' },
    { value: 'open_url', labelKey: 'app_studio.inspector.kind_open_url', labelEn: 'Open a web page' },
    { value: 'open_modal', labelKey: 'app_studio.inspector.kind_open_modal', labelEn: 'Open a dialog' },
    { value: 'close_modal', labelKey: 'app_studio.inspector.kind_close_modal', labelEn: 'Close a dialog' },
    { value: 'send_email', labelKey: 'app_studio.inspector.kind_send_email', labelEn: 'Send an e-mail' },
    { value: 'sequence', labelKey: 'app_studio.inspector.kind_sequence', labelEn: 'Several steps (a flow)' },
];

/**
 * Kinds the server ships that this editor deliberately does NOT offer, and why.
 *
 * Empty today, and that is the point: it exists so that removing a kind from
 * the list above has to be a decision someone wrote down. Without it, "the
 * select is missing a kind" and "the select deliberately omits a kind" look
 * identical to every test.
 */
export const NOT_OFFERED_HERE = {};

/** The card copy for the four primary kinds — label plus its consequence. */
export const CARD_COPY = {
    run_automation: {
        labelKey: 'app_studio.inspector.kind_run_automation',
        labelEn: 'Run automation',
        blurbKey: 'app_studio.inspector.blurb_run_automation',
        blurbEn: 'Hand the work to one of your automations and use what it sends back.',
    },
    navigate: {
        labelKey: 'app_studio.inspector.kind_navigate',
        labelEn: 'Go to screen',
        blurbKey: 'app_studio.inspector.blurb_navigate',
        blurbEn: 'Open another screen of this app, carrying values along.',
    },
    create_record: {
        labelKey: 'app_studio.inspector.kind_create_record',
        labelEn: 'Add a row',
        blurbKey: 'app_studio.inspector.blurb_create_record',
        blurbEn: 'Write a new row into one of this app’s own tables.',
    },
    toast: {
        labelKey: 'app_studio.inspector.kind_toast',
        labelEn: 'Show a message',
        blurbKey: 'app_studio.inspector.blurb_toast',
        blurbEn: 'A short confirmation or warning, here on this screen.',
    },
};

/** The label entry for one kind, or null for a kind this build does not know. */
export function kindLabel(kind) {
    return KIND_OPTIONS.find((o) => o.value === kind) || null;
}

/** The first `modal` node in the app — a new open/close_modal has to aim somewhere. */
export function firstModalId(definition) {
    let found = '';
    const walk = (nodes) => {
        for (const n of nodes || []) {
            if (found) return;
            if (n?.type === 'modal' && typeof n.id === 'string') { found = n.id; return; }
            if (Array.isArray(n?.children)) walk(n.children);
        }
    };
    for (const screen of definition?.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return found;
}

/**
 * Fresh per-kind defaults when the user switches an action's kind. `formFields`
 * (the enclosing form's inputs) lets ai_extract point at a document straight
 * away — `source` is required, so defaulting it empty means the builder meets a
 * validation error before touching anything.
 *
 * The lockstep test checks each result against ACTION_SPECS: every required
 * field present, and no field the spec does not know. A default that misses a
 * required field opens the editor on a validation error the author did not
 * cause; a default that invents a field is silently dropped on the first save.
 */
export function defaultActionForKind(kind, definition, formFields = []) {
    switch (kind) {
        case 'navigate': return { kind, screenId: definition?.screens?.[0]?.id || '' };
        case 'toast': return { kind, message: '', tone: 'info' };
        case 'open_url': return { kind, url: '', newTab: true };
        case 'ai_extract': {
            const file = formFields.find((f) => f.type === 'input_file')?.name || '';
            return {
                kind,
                ...(file ? { source: bindingForField(file) } : {}),
                schema: [{ name: 'field1', type: 'string', description: '', required: false }],
            };
        }
        case 'open_modal':
        case 'close_modal': return { kind, modalId: firstModalId(definition) };
        case 'send_email': return { kind, connectorId: '', to: { kind: 'static', value: '' }, subject: { kind: 'static', value: '' }, body: { kind: 'static', value: '' } };
        case 'ai_generate': return { kind, prompt: '', output: 'text', resultVar: 'result' };
        case 'kb_query': return { kind, query: { kind: 'static', value: '' }, knowledgeBaseIds: [], resultVar: 'results' };
        // A fresh "add a row" points at NO table on purpose. Guessing the first
        // table would be a write to a real table the author never chose — the
        // one default here that could quietly cost data. `values` starts empty
        // because the columns depend on the table that is not picked yet.
        case 'create_record': return { kind, tableId: '', values: {} };
        case 'sequence': return { kind, steps: [] };
        case 'run_automation':
        default: return { kind: 'run_automation', automationId: null };
    }
}
