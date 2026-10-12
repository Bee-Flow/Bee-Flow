'use strict';
/**
 * What the chat reports about the memories a turn used: the `memory_used` SSE
 * event and the `memoryUsed` field of the assistant message's meta.
 *
 * The SSE event carries ids, types and a short preview: the person's own memory
 * text going back to the person, live. The message meta stores ids and types
 * ONLY (`persistedMemoryUsed`): memory text never lands in a stored message,
 * where it would outlive the memory itself. The UI reloads previews by id
 * (GET /agents/memory?ids=), which no longer returns a deleted memory.
 */

const PREVIEW_CHARS = 120;

/**
 * @param {Array<{ id?: string, type?: string, content?: string }>} memories  as returned by findRelevantMemories
 * @returns {Array<{ id: string, type: string, preview: string, why: 'profile'|'relevant' }>}
 */
function memoryUsedItems(memories) {
    if (!Array.isArray(memories)) return [];
    return memories
        .filter(m => m && m.id)
        .map((m) => {
            const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
            return {
                id: String(m.id),
                type: String(m.type || ''),
                preview: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text,
                why: m.why === 'profile' ? 'profile' : 'relevant',
            };
        });
}

/**
 * What a stored assistant message keeps of the used memories: `[{id, type, why}]`,
 * an allow-list, never the preview or any other field.
 * @param {Array<{ id?: string, type?: string, why?: string }>} items
 * @returns {Array<{ id: string, type: string, why: string }>}
 */
function persistedMemoryUsed(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(i => i && i.id).map(i => ({ id: String(i.id), type: String(i.type || ''), why: i.why === 'profile' ? 'profile' : 'relevant' }));
}

/** Emit `memory_used` once, only for a non-empty list. Never throws. */
function emitMemoryUsed(send, items) {
    if (typeof send !== 'function' || !Array.isArray(items) || items.length === 0) return;
    try { send('memory_used', { items }); } catch (_) { /* never block the chat on an event */ }
}

module.exports = { memoryUsedItems, persistedMemoryUsed, emitMemoryUsed, PREVIEW_CHARS };
