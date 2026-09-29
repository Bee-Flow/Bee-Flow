/**
 * Snippet highlighting for the search overlay.
 *
 * The result goes into `dangerouslySetInnerHTML`, so the ONLY HTML this may
 * ever emit is the <mark> wrapper it adds itself. Snippets are conversation
 * content — whatever a user, a colleague in the same org or a model wrote —
 * and are therefore escaped unconditionally, before any early return.
 *
 * The bug this guards against: escaping used to live after a `if (!query)
 * return snippet` guard, so the no-query path returned the snippet raw.
 * Clearing the search box reaches exactly that path — `query` empties
 * immediately while the previous results stay on screen until the debounced
 * search clears them — which rendered any HTML the conversation contained.
 */

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const MARK_STYLE = 'background:color-mix(in srgb, var(--accent-primary) 25%, transparent);'
    + 'color:var(--text-primary);border-radius:3px;padding:0 2px;font-weight:600';

export const highlightSnippet = (snippet, query) => {
    const escaped = escapeHtml(snippet);
    if (!query) return escaped;
    // The query is escaped the same way before matching: the haystack is
    // already escaped, so a query containing & < > must match its entity form.
    const needle = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!needle) return escaped;
    return escaped.replace(
        new RegExp(`(${needle})`, 'gi'),
        `<mark style="${MARK_STYLE}">$1</mark>`,
    );
};

export default highlightSnippet;
