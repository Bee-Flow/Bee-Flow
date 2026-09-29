/**
 * Direct-chat notebook-write gate.
 *
 * BFSF-169 originally enforced this by REMOVING notebook_write /
 * notebook_replace / notebook_insert from the turn's tool list whenever the
 * user showed no write intent. That worked, but tools render before the
 * system prompt in Anthropic's wire format, so a tool list that changes
 * between turns invalidates the whole cached prefix — system block included.
 * A conversation that toggled write-intent on and off therefore rebuilt its
 * prompt cache on every turn.
 *
 * The tools now stay in the list for the whole conversation and the gate is
 * enforced at dispatch instead. The safety property is unchanged: a write the
 * user did not ask for is still impossible, because the call is rejected
 * before it reaches executeWorkspaceTool. The difference is that the model
 * gets an explanatory error instead of a missing tool, and the prefix stays
 * cacheable.
 */

const NOTEBOOK_WRITE_TOOLS = new Set(['notebook_write', 'notebook_replace', 'notebook_insert']);

/** Verbs that count as an explicit request to produce a written artefact. */
const WRITE_INTENT_RE = /(write|save|note|memo|draft|brief|report)/i;
/** Words that name the notebook itself, in EN and NL. */
const NOTEBOOK_WORD_RE = /(notebook|notitie|noteer|kladblok)/i;

function isNotebookWriteTool(toolName) {
    return NOTEBOOK_WRITE_TOOLS.has(toolName);
}

/**
 * Decide whether notebook writes are permitted for this turn.
 *
 * @param {object}  params
 * @param {string}  params.message              The user's message this turn.
 * @param {boolean} params.hasAttachment        Attachments present this turn.
 * @param {boolean} params.notebookPanelOpen    Panel currently open in the UI.
 * @returns {{allowed: boolean, reason: string|null}}
 *          `reason` is written for the model to read back — it explains what
 *          the user would have to say to unlock the write.
 */
function evaluateNotebookWriteGate({ message, hasAttachment, notebookPanelOpen }) {
    const text = typeof message === 'string' ? message : '';
    const hasWriteIntent = WRITE_INTENT_RE.test(text);

    // Attachment Q&A shape: a short content question about a file. Privacy
    // Shield tokenisation makes such answers look long, which used to steer
    // the model into a tool-only notebook_write and surfaced to the user as
    // "Error generating response".
    if (hasAttachment && text.length < 80 && !hasWriteIntent) {
        return {
            allowed: false,
            reason: 'This turn is a question about an attached file, not a request to write to the notebook. Answer in chat instead. If the user wants the answer saved, they will ask for it explicitly.',
        };
    }

    // Deterministic write gate: only offer writes when the user showed intent
    // or is already working in an open panel.
    if (!notebookPanelOpen && !(hasWriteIntent || NOTEBOOK_WORD_RE.test(text))) {
        return {
            allowed: false,
            reason: 'The user has not asked for anything to be written to the notebook and the Notebook panel is closed. Reply in chat instead. Only write to the notebook when the user explicitly asks (e.g. "save this to the notebook", "zet dit in mijn notitie").',
        };
    }

    return { allowed: true, reason: null };
}

module.exports = {
    isNotebookWriteTool,
    evaluateNotebookWriteGate,
    NOTEBOOK_WRITE_TOOLS,
};
