// @typecheck
/**
 * Read-path repair for conversations damaged by BFSF-307.
 *
 * Until the fix, `chatStream.js` persisted the array it had shaped for the LLM:
 * attachment-hydrated (content became an array of blocks), attachment-expanded
 * (the whole extracted PDF concatenated into the first text block) and compacted
 * (the oldest turns DELETED and replaced by four synthetic priming messages).
 * `updateConversation` is a destructive full replace, so that shape is what sits
 * in `conversation_messages` / `messages_json` for every affected conversation.
 *
 * Two visible consequences, both fixed here:
 *
 *   1. Array content reaches the UI, which does `String(content)` → the
 *      "[object Object],[object Object]" in the bug report, and the reload
 *      filters drop such turns entirely so whole answers vanish.
 *   2. The synthetic acknowledgements render as assistant bubbles — words the
 *      model never emitted, sitting in a transcript users copy and export.
 *
 * This runs on READ rather than as a migration because:
 *   - `messages_json` is encrypted with the user's session-derived key, which an
 *     offline script cannot derive; only in-request code can touch both stores.
 *   - Changing row counts offline would break the count-match guard in
 *     conversationMessages.migrateConversationIfNeeded, leaving the corrupt blob
 *     served forever.
 *   - It is idempotent and needs no migration window, and the next
 *     updateConversation bakes the clean shape in permanently.
 *
 * WHAT IT CANNOT DO: the turns compaction folded away are gone from the
 * application database. There is no history table, no soft delete, no audit
 * copy. This makes the wreckage readable and honest; it does not undo it.
 */

const { COMPACTION_MARKERS } = require('../../core/llm/compaction');

/**
 * Headers `attachmentProcessor` splices in front of extracted document text.
 * Everything from the first match onward is machine-generated replay, not
 * something the user typed — see attachmentProcessor.formatTextHeader and
 * friends. Anchored on the `\n\n[` the writer always emits so a user typing a
 * bracketed line cannot trigger a cut.
 */
const ATTACHMENT_HEADER_RE = /\n\n\[(?:[^\]\n]*—\s*(?:extracted via|\d+\s+pages?\s+rendered|could not extract text)|Attachment:|Gmail:)/;

/** Longest text block wins? No — the FIRST one. See flattenContent. */
function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (!Array.isArray(content)) {
        // Numbers/booleans survived a JSON.parse round-trip in rowToMessage.
        return typeof content === 'object' ? '' : String(content);
    }
    // The FIRST text block is the user's own message; every later text block is
    // hydrated `extractedText` replay, and every image_url block is reconstructible
    // from the `attachments` sidecar. Both are dropped deliberately.
    const first = content.find(b => b && b.type === 'text' && typeof b.text === 'string');
    if (!first) return '';
    const cut = first.text.search(ATTACHMENT_HEADER_RE);
    return cut === -1 ? first.text : first.text.slice(0, cut);
}

const textOf = (msg) => flattenContent(msg && msg.content).trimStart();

/**
 * Is this message one of compaction's synthetic priming turns?
 * Returns 'goal' | 'goal_ack' | 'summary' | 'summary_ack' | null.
 */
function classifySynthetic(msg) {
    if (!msg) return null;
    const text = textOf(msg);
    if (msg.role === 'user') {
        if (text.startsWith(COMPACTION_MARKERS.GOAL_PREFIX)) return 'goal';
        if (text.startsWith(COMPACTION_MARKERS.SUMMARY_PREFIX)
            || text.startsWith(COMPACTION_MARKERS.SUMMARY_PREFIX_NO_TEXT)) return 'summary';
    } else if (msg.role === 'assistant') {
        if (text === COMPACTION_MARKERS.GOAL_ACK) return 'goal_ack';
        if (text === COMPACTION_MARKERS.SUMMARY_ACK) return 'summary_ack';
    }
    return null;
}

/**
 * Repair a stored message array for display.
 *
 * @param {Array}  messages
 * @param {object} [opts]
 * @param {boolean} [opts.wasCompacted=false] Whether this conversation's meta
 *   carries a compaction summary/watermark. Gates synthetic removal entirely:
 *   in a never-compacted conversation the filter cannot fire, so no genuine
 *   message can be hidden by it.
 * @returns {{ messages: Array, hiddenCount: number, summarised: boolean, repairedCount: number }}
 */
function normalizeStoredMessages(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { messages: messages || [], hiddenCount: 0, summarised: false, repairedCount: 0 };
    }
    const wasCompacted = opts.wasCompacted === true;

    let hiddenCount = 0;
    let repairedCount = 0;
    let summarised = false;
    let changed = false;

    // Synthetics only ever appear at the HEAD of the array (compactMessages
    // builds [systems, goalPair?, summaryPair?, ...recent]). Scanning the whole
    // array would risk matching a real message that quotes the marker; stopping
    // at the first non-synthetic makes that impossible by construction.
    const drop = new Set();
    if (wasCompacted) {
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (m && m.role === 'system') continue;   // systems are hoisted to the front
            const kind = classifySynthetic(m);
            if (!kind) break;                          // first real turn — stop scanning

            if (kind === 'goal' || kind === 'summary') {
                // Match the PAIR, not the lone message: a user can type the
                // marker, but cannot also make the very next assistant turn
                // byte-identical to the canned acknowledgement.
                const ackKind = classifySynthetic(messages[i + 1]);
                const expected = kind === 'goal' ? 'goal_ack' : 'summary_ack';
                if (ackKind !== expected) break;

                if (kind === 'goal') {
                    drop.add(i);
                } else {
                    // The summary is often the ONLY surviving trace of the folded
                    // turns, and it carries the hoisted attachments sidecar. Keep
                    // it, flattened and tagged, so the UI can render it as a
                    // divider instead of an [object Object] user bubble.
                    summarised = true;
                }
                drop.add(i + 1);
                i++;                                   // consume the acknowledgement
            }
        }
    }

    const out = [];
    for (let i = 0; i < messages.length; i++) {
        if (drop.has(i)) { hiddenCount++; changed = true; continue; }
        const m = messages[i];
        if (!m || typeof m !== 'object') { out.push(m); continue; }

        let next = m;
        if (Array.isArray(m.content)) {
            next = { ...m, content: flattenContent(m.content) };
            repairedCount++;
            changed = true;
        }
        if (wasCompacted && classifySynthetic(next) === 'summary') {
            next = { ...next, compactionArtifact: true };
            changed = true;
        }
        out.push(next);
    }

    return {
        messages: changed ? out : messages,
        hiddenCount,
        summarised,
        repairedCount,
    };
}

module.exports = { normalizeStoredMessages, flattenContent, classifySynthetic };
