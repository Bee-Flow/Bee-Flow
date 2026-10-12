/**
 * Which Studio documents the chat model may touch in a turn.
 *
 * Privacy rule: the AI reads a person's documents ONLY when the person pointed
 * at them. A document is in scope when
 *   (a) it is the one open next to the chat (`sidePanelDocument`, the Documents
 *       button above the chat),
 *   (b) the chat itself created it: a `create_document` or
 *       `create_presentation` result recorded in the conversation's tool
 *       history (`toolHistory[].resultPreview` holds the start of the result's
 *       JSON, with its `documentId`), or a `create_document` call made earlier
 *       in THIS turn (added live through `add`). A link in the ASSISTANT's text
 *       does not count: a prompt injection could make the model echo one, and
 *       a document the model never made would slip into scope,
 *   (c) its id, or a Bee Flow document link, appears in a USER message of this
 *       conversation (an explicit reference).
 * Anything else is refused by the tools, with an answer that does not say
 * whether the document exists.
 *
 * Pure: no store, no I/O. The request body is untrusted, so every input is
 * shape-checked and a malformed value simply contributes nothing.
 */

const MAX_ID = 100;
const MAX_NAME = 200;
// Document ids are UUIDs (stores/documentStore.js).
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CREATE_TOOLS = new Set(['create_document', 'create_presentation']);
const CREATED_RE = /"documentId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

const NOT_SHARED = 'This document has not been shared with this chat. Ask the user to open it with the Documents button above the chat, or to paste its link.';

const norm = (id) => String(id).toLowerCase();

/**
 * The request's `sidePanelDocument`, or null when it is not a usable
 * `{ id: string <= 100 chars, name?: string }`. The name is a display hint:
 * single line, capped.
 */
function normaliseSidePanelDocument(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = raw.id;
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    if (!trimmed || trimmed.length > MAX_ID) return null;
    const out = { id: trimmed };
    if (typeof raw.name === 'string') {
        const name = raw.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME);
        if (name) out.name = name;
    }
    return out;
}

function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('\n');
    }
    return '';
}

function matches(re, text) {
    const out = [];
    for (const m of text.matchAll(re)) out.push(m[1] || m[0]);
    return out;
}

/**
 * @param {object} [input]
 * @param {unknown} [input.sidePanelDocument]  the untrusted request field
 * @param {unknown[]} [input.history]          the conversation's messages so far
 * @param {string} [input.message]             the user's message of this turn
 * @returns {{ has(id: unknown): boolean, add(id: unknown): void, markCreated(id: unknown): void, createdInChat(id: unknown): boolean, ids(): string[] }}
 */
function createDocumentScope({ sidePanelDocument, history, message } = {}) {
    const allowed = new Set();
    // The subset the chat itself made: a document the AI may write to directly
    // (core/documents/suggestions/policy.js), unlike one merely opened.
    const created = new Set();
    const add = (id) => {
        if (typeof id === 'string' && id.trim() && id.length <= MAX_ID) allowed.add(norm(id.trim()));
    };
    const markCreated = (id) => {
        add(id);
        if (typeof id === 'string' && id.trim() && id.length <= MAX_ID) created.add(norm(id.trim()));
    };

    const panel = normaliseSidePanelDocument(sidePanelDocument);
    if (panel) add(panel.id);

    const userTexts = [];
    if (typeof message === 'string') userTexts.push(message);
    for (const msg of Array.isArray(history) ? history : []) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.role === 'user') {
            userTexts.push(textOf(msg.content));
        } else if (msg.role === 'assistant') {
            for (const t of Array.isArray(msg.toolHistory) ? msg.toolHistory : []) {
                if (t && CREATE_TOOLS.has(t.name) && typeof t.resultPreview === 'string') {
                    const m = CREATED_RE.exec(t.resultPreview);
                    if (m) markCreated(m[1]);
                }
            }
        }
    }
    for (const text of userTexts) {
        for (const id of matches(UUID_RE, text)) add(id);
    }

    return {
        has: (id) => typeof id === 'string' && allowed.has(norm(id.trim())),
        add,
        markCreated,
        createdInChat: (id) => typeof id === 'string' && created.has(norm(id.trim())),
        ids: () => [...allowed],
    };
}

module.exports = { createDocumentScope, normaliseSidePanelDocument, NOT_SHARED };
