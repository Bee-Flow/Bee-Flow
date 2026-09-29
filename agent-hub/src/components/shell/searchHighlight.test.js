// @vitest-environment node
/**
 * Snippet highlighting feeds dangerouslySetInnerHTML, so the escaping is the
 * security boundary: the only HTML it may emit is its own <mark> wrapper.
 *
 * Run: cd agent-hub && npx vitest run src/components/shell/searchHighlight.test.js
 */
import { describe, it, expect } from 'vitest';
import { highlightSnippet } from './searchHighlight';

describe('highlightSnippet', () => {
    it('escapes markup when there is no query', () => {
        // Regression: this path used to return the snippet raw, and it is
        // reachable — clearing the search box empties the query while the
        // previous results are still on screen.
        const out = highlightSnippet('<img src=x onerror=alert(1)>', '');
        expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(out).not.toContain('<img');
    });

    it('escapes markup when there is a query', () => {
        const out = highlightSnippet('<script>alert(1)</script> hello', 'hello');
        expect(out).not.toContain('<script');
        expect(out).toContain('&lt;script&gt;');
    });

    it('wraps only the match in a mark element', () => {
        const out = highlightSnippet('the quick fox', 'quick');
        expect(out).toContain('<mark style="');
        expect(out).toContain('>quick</mark>');
        expect(out.match(/<mark/g)).toHaveLength(1);
    });

    it('matches case-insensitively', () => {
        expect(highlightSnippet('Hello world', 'hello')).toContain('>Hello</mark>');
    });

    it('treats regex metacharacters in the query as literals', () => {
        const out = highlightSnippet('cost is 3+4 euro', '3+4');
        expect(out).toContain('>3+4</mark>');
    });

    it('does not let a markup query re-open a tag in the escaped snippet', () => {
        // The haystack is escaped, so the query is escaped the same way before
        // matching — otherwise `<b>` would match nothing, or worse, match the
        // unescaped source of an entity.
        const out = highlightSnippet('a <b> tag', '<b>');
        expect(out).not.toContain('<b>');
        expect(out).toContain('&lt;b&gt;</mark>');
    });

    it('handles null and undefined snippets', () => {
        expect(highlightSnippet(null, 'x')).toBe('');
        expect(highlightSnippet(undefined, '')).toBe('');
    });
});
