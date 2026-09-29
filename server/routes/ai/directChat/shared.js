/**
 * Direct Chat — small helpers shared by the route modules in this folder.
 *
 * Moved verbatim out of routes/ai/directChat.js when the router was split.
 */

/**
 * Build a short, TOOL-FREE transcript for conversation-title generation:
 * the first two user+assistant exchanges as plain "User:/Assistant:" lines,
 * with any tool calls/results stripped. The title model has no tools and must
 * not be primed with tool noise (it otherwise hallucinates code blocks in
 * tool-heavy chats). Each line is capped so the whole thing stays tiny.
 */
function buildTitleTranscript(savedMessages) {
    if (!Array.isArray(savedMessages)) return '';
    const lines = [];
    let users = 0, assistants = 0;
    for (const m of savedMessages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (m.role === 'user' && users >= 2) continue;
        if (m.role === 'assistant' && assistants >= 2) continue;
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) {
            text = m.content
                .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text).join(' ');
        }
        text = (text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > 500) text = text.slice(0, 500);
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
        if (m.role === 'user') users++; else assistants++;
        if (users >= 2 && assistants >= 2) break;
    }
    return lines.join('\n');
}

/**
 * Extract a (possibly unterminated) JSON string field from a partial JSON
 * fragment that is still streaming in. Used to live-stream a tool argument
 * (e.g. notebook_write's `content`) before the full tool call is complete.
 * Returns the decoded string value, or null if the field hasn't started yet.
 */
function extractPartialJsonString(partial, field) {
    if (typeof partial !== 'string') return null;
    const keyRe = new RegExp(`"${field}"\\s*:\\s*"`);
    const m = keyRe.exec(partial);
    if (!m) return null;
    let out = '';
    for (let i = m.index + m[0].length; i < partial.length; i++) {
        const c = partial[i];
        if (c === '\\') {
            const next = partial[i + 1];
            if (next === undefined) break;            // incomplete escape at the tail
            if (next === 'n') out += '\n';
            else if (next === 't') out += '\t';
            else if (next === 'r') out += '\r';
            else if (next === 'b') out += '\b';
            else if (next === 'f') out += '\f';
            else if (next === '"') out += '"';
            else if (next === '\\') out += '\\';
            else if (next === '/') out += '/';
            else if (next === 'u') {
                const hex = partial.slice(i + 2, i + 6);
                if (hex.length < 4) break;            // incomplete \uXXXX at the tail
                out += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            } else out += next;
            i += 1;                                    // skip the escaped char
        } else if (c === '"') {
            break;                                     // closing quote → string complete
        } else {
            out += c;
        }
    }
    return out;
}

/**
 * The caller's DEK, for the conversation store's encryption context.
 *
 * Direct chat has to hand this over explicitly. The agent runtime already does
 * (chatStream passes userAuth.encryptionKey into updateConversation), but this
 * path never did — so on the `zk` tier, which has no escrow to fall back on,
 * resolveCrypto found no key and every direct-chat message was written in
 * plaintext even with encryption switched on for the org.
 *
 * On `managed` the escrow covers a null here, so this is additive rather than
 * load-bearing for that tier.
 */
function encryptionOpts(req) {
    return { encryptionKey: req?.session?.encryptionKey || null };
}

const orgHealth = require('../../../services/orgHealth');

// A successful stream is proof the org-level chat blocks are gone — resolve
// them (cheap: appends a timeline event only on an actual flip), throttled
// in-module to 1 call / org / 10 min so the hot path stays write-free.
// Never auth.* codes here: those are per-user conditions that may still hold
// for other users of the org.
const _chatResolveMarks = new Map();

/**
 * Announce something that happened in a shared thread to its project feed.
 *
 * Persist first (that is what assigns the gapless per-project sequence), then
 * publish — subscribers read forward from their cursor rather than trusting the
 * notification's contents, so a dropped publish costs latency and never data.
 *
 * Best-effort throughout: a live-feed update must never be able to fail the
 * chat turn that produced it.
 */
function emitThreadEvent(projectId, event) {
    return require('../../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'DirectChat' });
}
const CHAT_RESOLVE_WINDOW_MS = 10 * 60 * 1000;
function _resolveChatProblemsThrottled(orgId) {
    try {
        if (!orgId) return;
        const now = Date.now();
        const last = _chatResolveMarks.get(orgId);
        if (last != null && (now - last) < CHAT_RESOLVE_WINDOW_MS) return;
        _chatResolveMarks.set(orgId, now);
        if (_chatResolveMarks.size > 5000) _chatResolveMarks.clear();
        orgHealth.resolve(orgId, [
            'chat.subscription_blocked',
            'chat.provider_config_failed',
            'chat.provider_error',
            'chat.budget_exhausted',
        ]);
    } catch (_) { /* must never break chat */ }
}

module.exports = {
    buildTitleTranscript,
    extractPartialJsonString,
    encryptionOpts,
    emitThreadEvent,
    _resolveChatProblemsThrottled,
};
