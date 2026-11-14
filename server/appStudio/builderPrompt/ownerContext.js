// @typecheck strict
/**
 * App Studio builder: the owner's automations and documents as prompt text (split out of
 * builderPrompt.js, which re-exports every name here).
 */

'use strict';

// The machine note that carries the owner's automations and documents. Defined
// here (with the renderer) and listed in usecases/ai/appStudioBuilder/turnLoop.js
// MACHINE_PREFIXES so sanitizeHistory strips it from cross-turn history.
const OWNER_CONTEXT_PREFIX = '[OWNER CONTEXT — machine-generated: the owner\'s automations and documents]';

// ---------------------------------------------------------------------------
// Owner's automations — compact, per-user-stable list for the static prompt
// ---------------------------------------------------------------------------

/**
 * Render the automation rows from app_list_automations' mapper into prompt
 * text. Sorted by id so the text is stable for a given set of automations.
 * @param {AutomationRow[] | null | undefined} rows
 * @returns {string}
 */
function renderAutomationsText(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    return rows
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((a) => {
            const bits = [`- ${a.id} — "${a.title}"`];
            bits.push(a.isActive ? '[active]' : '[inactive]');
            bits.push(`trigger:${a.trigger}`);
            if (Array.isArray(a.params) && a.params.length) bits.push(`params: ${a.params.join(', ')}`);
            if (a.description) bits.push(`— ${a.description}`);
            return bits.join(' ');
        })
        .join('\n');
}

/**
 * The owner's designed documents, one line each, with the placeholders they
 * carry. Rendered into the system prompt rather than left behind
 * app_search_documents and app_read_document for the same reason the automations list is: a small model's
 * menu has no read tools at all, and a document it cannot discover is a
 * document it invents an id for. Sorted by id so the text is stable for a
 * given set of documents (the prompt is the front of the prompt cache).
 * @param {DocumentRow[] | null | undefined} rows
 * @returns {string}
 */
function renderDocumentsText(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    return 'Search beyond this catalog with app_search_documents. Before configuring fill_document, call app_read_document for all parameter instructions and selected sections, and pin its versionId as documentVersionId.\n' + rows
        .slice()
        .sort((a, b) => String(a.documentId || a.id).localeCompare(String(b.documentId || b.id)))
        .map((d) => {
            const holes = Array.isArray(d.placeholders) ? d.placeholders : [];
            const fills = holes.length
                ? holes.map((p) => (p.kind === 'list'
                    ? `${p.key} (list${p.fields?.length ? ` of ${p.fields.join(', ')}` : ''})`
                    : (p.kind === 'condition' ? `${p.key} (only if set)` : p.key))).join(', ')
                : 'no placeholders — sent exactly as designed';
            return `- ${d.documentId || d.id} — "${d.name}" [${d.docType || 'document'}] fills: ${fills}`;
        })
        .join('\n');
}

/**
 * The owner's automations and documents as ONE machine note for the folded user
 * message. Out of the system prompt on purpose: Gemma's chat template renders
 * the tools AFTER the system content, so a per-user list there moved every
 * byte of the tool block and the few-shots for every user and every session
 * — the whole ~7k-token prefix re-read on the box's only slot. Here it is the
 * last thing before the user's words, where a turn's variable bytes belong.
 *
 * `maxAutomations` caps the list: a small model reads 40 lines of ids fine and
 * 100 badly; the tail says how to get the rest.
 * @param {AutomationRow[] | null | undefined} automationRows
 * @param {DocumentRow[] | null | undefined} documentRows
 * @param {{ maxAutomations?: number }} [opts]
 * @returns {string}
 */
function renderOwnerContextNote(automationRows, documentRows, { maxAutomations = 40 } = {}) {
    const rows = Array.isArray(automationRows) ? automationRows : [];
    const shown = rows.length > maxAutomations
        ? rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, maxAutomations)
        : rows;
    const automations = shown.length
        ? renderAutomationsText(shown) + (rows.length > shown.length ? `\n(${rows.length - shown.length} more — name the automation you mean and I will find it)` : '')
        : '(none — the owner has no automations yet; a run_automation action may ship with automationId:null and be connected later)';
    const docs = Array.isArray(documentRows) && documentRows.length
        ? renderDocumentsText(documentRows)
        : '(none — the owner has no designed documents, so a fill_document step cannot be built)';
    return `${OWNER_CONTEXT_PREFIX}\nAutomations (wire via run_automation with these exact ids):\n${automations}\n\nDocuments (fill via a fill_document step):\n${docs}`;
}

module.exports = { OWNER_CONTEXT_PREFIX, renderAutomationsText, renderDocumentsText, renderOwnerContextNote };

/**
 * @typedef {{ id: string, title?: string, isActive?: boolean, trigger?: string, params?: string[], description?: string }} AutomationRow
 * @typedef {{ id?: string, documentId?: string, name?: string, docType?: string, placeholders?: Array<{ key: string, kind?: string, fields?: string[] }> }} DocumentRow
 */
