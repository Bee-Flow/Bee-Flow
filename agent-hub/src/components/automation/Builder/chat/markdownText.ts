/**
 * Small text helpers for lines the model wrote that the chat draws itself:
 * plan lines and question prompts.
 */

// The plan view numbers the steps (01, 02, ...) and draws its own bullet. A
// "1." or "- " the model put in front of a line would show up twice. Only a
// marker followed by a space goes: "3 retries on failure" and "1.5 seconds" are
// text, and "**Bold** first" starts with a star but is not a bullet. The server
// strips the same markers from a new plan (workMode.stripListMarker); this
// covers a plan that was saved before that.
const LIST_MARKER = /^\s*(?:(?:\d{1,3}[.)]|[-*•])\s+)+/;

export function stripListMarker(line: unknown): string {
    const text = String(line ?? '');
    return text.replace(LIST_MARKER, '').trim() || text.trim();
}

/**
 * The words of a line without its inline markdown, for an aria-label or a
 * title attribute, where "**" and backticks would be read out or shown.
 */
export function stripInlineMarkdown(text: unknown): string {
    return String(text ?? '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(^|\s)[*_]+(\S)/g, '$1$2')
        .replace(/(\S)[*_]+(?=\s|$)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}
