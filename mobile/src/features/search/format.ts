/**
 * Presentation helpers for the search screen.
 *
 * `relativeTime` is deliberately a local copy rather than an import from
 * another feature — the same choice library/format.ts and automate/format.ts
 * already made. Each feature owning its own two-line formatter is what keeps
 * the folders independent; a shared "utils" module that three features import
 * is the thing this codebase does not have.
 */

/** Case-insensitive substring test that tolerates null columns. */
export function matches(haystack: string | null | undefined, needle: string): boolean {
    if (!haystack) return false;
    return haystack.toLowerCase().includes(needle);
}

/**
 * A window of `text` around the first occurrence of `query`.
 *
 * The web overlay does the same thing (agent-hub SearchOverlay processResults)
 * so a result reads the same on both clients. Ellipses mark a trimmed edge, so
 * a snippet never pretends to be the start of the document.
 */
export function snippetAround(text: string, query: string, width = 90): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const at = flat.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return flat.length > width ? `${flat.slice(0, width)}…` : flat;
    const start = Math.max(0, at - 32);
    const end = Math.min(flat.length, at + query.length + width - 32);
    return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Pull a matching line out of a legacy conversation blob.
 *
 * `messages_json` only rides along on the non-migrated, unencrypted search
 * path (stores/agent/directConversations.js strategy B), where it is a JSON
 * array of `{role, content}`. Everywhere else it is absent and the caller
 * falls back to explaining that the title matched. A malformed blob must never
 * drop the row from the results.
 */
export function conversationSnippet(
    messagesJson: string | null | undefined,
    query: string,
): string | null {
    if (!messagesJson) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(messagesJson);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const lower = query.toLowerCase();
    for (const entry of parsed) {
        const content = (entry as { content?: unknown } | null)?.content;
        if (typeof content === 'string' && content.toLowerCase().includes(lower)) {
            return snippetAround(content, query);
        }
    }
    return null;
}
