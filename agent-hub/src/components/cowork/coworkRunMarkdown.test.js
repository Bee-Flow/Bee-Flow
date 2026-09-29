// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { neutraliseActiveFences } from './coworkRunMarkdown';

/**
 * The property under test: after this function runs, no fenced block in the
 * text carries a language the shared Markdown renderer would turn into a live
 * component — and nothing else about the text has moved.
 */

const fence = (info, body = '{"embedUrl":"https://attacker.example/x"}') =>
    ['```' + info, body, '```'].join('\n');

describe('neutraliseActiveFences — the languages that render as components', () => {
    it.each([
        'map-embed', 'map', 'maps',
        'vega-lite', 'vegalite', 'vega',
        'mermaid',
        'json-page', 'page', 'page-json',
        'json-research', 'research',
        'test-report', 'workspace',
    ])('rewrites a ```%s fence to a plain one', (language) => {
        const out = neutraliseActiveFences(fence(language));
        expect(out).not.toContain(language);
        expect(out.split('\n')[0]).toBe('```plaintext');
    });

    it('rewrites a language nobody has invented yet — the default is inert', () => {
        // The point of the allow-list: the renderer someone adds next year is
        // neutral here on the day it lands, with no edit to this file.
        expect(neutraliseActiveFences(fence('video-embed')).split('\n')[0]).toBe('```plaintext');
        expect(neutraliseActiveFences(fence('calendar-invite')).split('\n')[0]).toBe('```plaintext');
    });

    it('keeps the block body untouched, so nothing the model wrote disappears', () => {
        const out = neutraliseActiveFences(fence('map-embed', 'line one\nline two'));
        expect(out).toBe('```plaintext\nline one\nline two\n```');
    });

    it('does not rewrite to a language the renderer unwraps when it wraps the whole message', () => {
        // MarkdownRenderer strips a leading ```/```text/```md fence off the
        // whole message. Rewriting to one of those would spill the block body
        // back into the document as Markdown.
        const first = neutraliseActiveFences(fence('map-embed')).split('\n')[0];
        expect(['```', '```text', '```md', '```markdown']).not.toContain(first);
    });
});

describe('neutraliseActiveFences — a fence the reader would call quoted', () => {
    // The bypass this block exists for: CommonMark parses "> ```map-embed" as
    // a fenced block with an info string, exactly like the unquoted form, and
    // so does react-markdown. Two characters of prefix must not be a way round
    // the allow-list — and a quoted mail footer is precisely where injected
    // text arrives from.

    it('rewrites a fence inside a block quote', () => {
        const quoted = ['> ```map-embed', '> {"embedUrl":"https://attacker.example/x"}', '> ```'].join('\n');
        const out = neutraliseActiveFences(quoted);
        expect(out).not.toContain('map-embed');
        expect(out.split('\n')[0]).toBe('> ```plaintext');
    });

    it('keeps the quote marker, so the block still reads as quoted', () => {
        const out = neutraliseActiveFences(['> ```mermaid', '> graph TD;', '> ```'].join('\n'));
        expect(out.split('\n')).toEqual(['> ```plaintext', '> graph TD;', '> ```']);
    });

    it.each([
        ['no space after the marker', '>```map-embed'],
        ['a nested quote', '> > ```map-embed'],
        ['a bullet list item', '- ```map-embed'],
        ['a numbered list item', '1. ```map-embed'],
        ['a quoted bullet', '> - ```map-embed'],
    ])('rewrites a fence behind %s', (_label, opener) => {
        const out = neutraliseActiveFences([opener, 'body', '```'].join('\n'));
        expect(out).not.toContain('map-embed');
        expect(out.split('\n')[0]).toContain('```plaintext');
    });

    it('still leaves an inert quoted fence byte for byte alone', () => {
        const input = ['> ```js', '> const a = 1;', '> ```'].join('\n');
        expect(neutraliseActiveFences(input)).toBe(input);
    });
});

describe('neutraliseActiveFences — what it must leave alone', () => {
    it.each(['js', 'javascript', 'python', 'json', 'bash', 'sql', 'html', 'yaml', 'diff', 'text', ''])(
        'leaves a ```%s fence exactly as it was',
        (language) => {
            const input = fence(language, 'body');
            expect(neutraliseActiveFences(input)).toBe(input);
        },
    );

    it('matches the language case-insensitively', () => {
        expect(neutraliseActiveFences(fence('JSON', 'body'))).toBe(fence('JSON', 'body'));
        expect(neutraliseActiveFences(fence('Map-Embed')).split('\n')[0]).toBe('```plaintext');
    });

    it('leaves prose, headings, links and inline code alone', () => {
        const input = '# Title\n\nSee [docs](https://example.com) and `map-embed` inline.\n';
        expect(neutraliseActiveFences(input)).toBe(input);
    });

    it('does not touch a fence marker that appears inside an open block', () => {
        // The body of a plain block may itself contain fence-looking lines;
        // they are text, not openers.
        const input = ['```text', '```map-embed', '{"embedUrl":"x"}', '```'].join('\n');
        expect(neutraliseActiveFences(input)).toBe(input);
    });

    it('keeps a tilde fence a tilde fence, and closes on its own marker', () => {
        expect(neutraliseActiveFences('~~~map-embed\nbody\n~~~')).toBe('~~~plaintext\nbody\n~~~');
        // A ``` line inside a ~~~ block does not close it, so the second
        // marker is body text rather than a new opener.
        const mixed = ['~~~text', '```map-embed', 'body', '```', '~~~'].join('\n');
        expect(neutraliseActiveFences(mixed)).toBe(mixed);
    });

    it('keeps a backtick fence a backtick fence, and closes on its own marker', () => {
        // The mirror of the tilde case above, which was the only side tested:
        // a ~~~ line inside a ``` block is body text, not a closer. Without
        // that rule the block ends early and the NEXT line is read as a fresh
        // opener — so a ```map-embed sitting inside a quoted code sample would
        // be rewritten and the text would move under the reader.
        const mixed = ['```js', '~~~', 'const a = 1;', '```map-embed', 'x', '```'].join('\n');
        expect(neutraliseActiveFences(mixed)).toBe(mixed);
    });

    it('needs a closer at least as long as its opener', () => {
        // ```` opens; a three-tick line inside it is body, not the close. If a
        // shorter marker were allowed to close, everything after it would be
        // re-read as top-level text and rewritten a second time — the block's
        // own contents would move under the reader.
        const input = ['````map-embed', '```', '```map-embed', 'x', '````'].join('\n');
        expect(neutraliseActiveFences(input)).toBe(
            ['````plaintext', '```', '```map-embed', 'x', '````'].join('\n'),
        );
    });

    it('handles more than one block in one result', () => {
        const input = ['```js', 'a', '```', '', '```map-embed', 'b', '```'].join('\n');
        expect(neutraliseActiveFences(input)).toBe(
            ['```js', 'a', '```', '', '```plaintext', 'b', '```'].join('\n'),
        );
    });

    it('handles an indented fence and an over-long marker', () => {
        expect(neutraliseActiveFences('  ````map-embed\nbody\n  ````')).toBe('  ````plaintext\nbody\n  ````');
    });

    it('neutralises a fence that is never closed', () => {
        // Truncated output is still output, and still reaches the renderer.
        expect(neutraliseActiveFences('```map-embed\n{"embedUrl":"x"}')).toBe('```plaintext\n{"embedUrl":"x"}');
    });

    it('ignores a line whose info string contains a backtick — that opens nothing', () => {
        const input = ['```a`b', '```map-embed', 'body', '```'].join('\n');
        expect(neutraliseActiveFences(input)).toBe(['```a`b', '```plaintext', 'body', '```'].join('\n'));
    });
});

describe('neutraliseActiveFences — non-string input', () => {
    it.each([null, undefined, 42, {}])('returns %s unchanged', (value) => {
        expect(neutraliseActiveFences(value)).toBe(value);
    });

    it('returns the empty string unchanged', () => {
        expect(neutraliseActiveFences('')).toBe('');
    });
});
