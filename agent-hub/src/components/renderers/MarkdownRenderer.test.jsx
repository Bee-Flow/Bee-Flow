/**
 * BFSF-259 + BFSF-273 — chat markdown rendering regression guards.
 *
 * 259: Tailwind preflight kills list markers; index.css must restore
 *      list-style on .markdown-content ol/ul (jsdom doesn't apply
 *      stylesheets, so the CSS rules are asserted as strings — same style as
 *      the noPurple tests) while GFM task lists stay marker-less.
 * 273: react-markdown v10 removed the `inline` prop — the PreContext-based
 *      detection must route genuine backtick inline code to the cheap
 *      .inline-code span (no <pre>), keep compact no-language fenced chips
 *      inside a <pre> (the DOM shape the wrapping CSS fix targets), and keep
 *      language-tagged blocks in the full CollapsibleCodeBlock.
 *
 * Run: cd agent-hub && npx vitest run src/components/MarkdownRenderer.test.jsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// Heavy leaf renderers are irrelevant here — mock them out so jsdom doesn't
// pull mermaid/vega.
vi.mock('./MermaidRenderer', () => ({ default: () => <div data-testid="mermaid" /> }));
vi.mock('./VegaLiteRenderer', () => ({ default: () => <div data-testid="vega" /> }));

import MarkdownRenderer from './MarkdownRenderer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_CSS = fs.readFileSync(path.resolve(HERE, '../../index.css'), 'utf8');

describe('BFSF-259 — ordered/unordered lists', () => {
    it('renders a typed numbered list as a real <ol> with its items intact', () => {
        const { container } = render(<MarkdownRenderer content={'intro\n\n1. een\n2. twee\n3. drie'} />);
        const ol = container.querySelector('ol');
        expect(ol).not.toBeNull();
        const items = [...ol.querySelectorAll('li')].map(li => li.textContent.trim());
        expect(items).toEqual(['een', 'twee', 'drie']);
    });

    it('GFM task lists carry .contains-task-list with a checkbox (no double markers)', () => {
        const { container } = render(<MarkdownRenderer content={'- [ ] taak één\n- [x] taak twee'} />);
        const ul = container.querySelector('.contains-task-list');
        expect(ul).not.toBeNull();
        expect(ul.querySelectorAll('input[type="checkbox"]').length).toBe(2);
    });

    it('index.css restores list markers and exempts task lists (class-based, ol included)', () => {
        // The renderer relies on author CSS beating Tailwind preflight — pin
        // the exact declarations so a cleanup can't silently drop them.
        expect(INDEX_CSS).toMatch(/\.markdown-content ol \{[^}]*list-style:\s*decimal outside/);
        expect(INDEX_CSS).toMatch(/\.markdown-content ul \{[^}]*list-style:\s*disc outside/);
        expect(INDEX_CSS).toMatch(/\.markdown-content \.contains-task-list \{[^}]*list-style:\s*none/);
    });
});

describe('BFSF-273 — inline vs fenced code routing (PreContext)', () => {
    it('genuine backtick inline code renders as .inline-code with NO <pre> wrapper', () => {
        const { container } = render(<MarkdownRenderer content={'use `beeflow.config.reallyLongToken` here'} />);
        const code = container.querySelector('code.inline-code');
        expect(code).not.toBeNull();
        expect(code.closest('pre')).toBeNull();
        expect(code.textContent).toBe('beeflow.config.reallyLongToken');
    });

    it('a short no-language fenced block embedded mid-message stays a compact chip inside <pre>', () => {
        // Must be EMBEDDED — a fence spanning the whole message is unwrapped
        // by stripWrappingCodeBlock before parsing.
        const long = 'x'.repeat(300);
        const { container } = render(<MarkdownRenderer content={`Here is your prompt:\n\n\`\`\`\n${long}\n\`\`\`\n\nCopy it.`} />);
        const chip = container.querySelector('pre code.inline-code');
        expect(chip, 'compact chip keeps the pre>code.inline-code DOM shape the wrap CSS targets').not.toBeNull();
        expect(chip.textContent).toContain('xxx');
    });

    it('language-tagged multi-line blocks still mount the full code block UI', () => {
        const { container } = render(<MarkdownRenderer content={'intro\n\n```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```'} />);
        // Full block: no compact chip, real highlighted <pre><code> present.
        expect(container.querySelector('pre code.inline-code')).toBeNull();
        const block = container.querySelector('pre code');
        expect(block).not.toBeNull();
        expect(block.textContent).toContain('const a = 1;');
    });

    it('index.css declares wrapping on .inline-code (pre-wrap + anywhere)', () => {
        const rule = INDEX_CSS.match(/\.markdown-content \.inline-code \{[^}]*\}/);
        expect(rule).not.toBeNull();
        expect(rule[0]).toContain('white-space: pre-wrap');
        expect(rule[0]).toContain('overflow-wrap: anywhere');
    });
});

describe('MarkdownRenderer inline mode', () => {
    it('keeps bold, italics, code and links, in a span rather than a block', () => {
        const { container } = render(<MarkdownRenderer inline content={'A **bold** and *soft* word, `code` and [a link](https://example.test).'} />);
        expect(container.firstElementChild.tagName).toBe('SPAN');
        expect(container.querySelector('strong').textContent).toBe('bold');
        expect(container.querySelector('em').textContent).toBe('soft');
        expect(container.querySelector('code.inline-code').textContent).toBe('code');
        const a = container.querySelector('a');
        expect(a.getAttribute('href')).toBe('https://example.test');
        expect(a.getAttribute('target')).toBe('_blank');
        expect(container.querySelector('p')).toBeNull();
    });

    it('unwraps blocks to their text: no list, heading, quote, table or fence', () => {
        const md = '# Title\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
        const { container } = render(<MarkdownRenderer inline content={md} />);
        expect(container.querySelector('h1, ul, ol, li, blockquote, pre, table, .table-wrapper')).toBeNull();
        for (const word of ['Title', 'one', 'two', 'first', 'quoted']) expect(container.textContent).toContain(word);
        // The words do not run together: the line breaks between blocks survive for white-space: pre-line.
        expect(container.textContent).toMatch(/one\s+two/);
    });

    it('does not turn dollar amounts into math', () => {
        const { container } = render(<MarkdownRenderer inline content={'It costs $5 and then $6 more.'} />);
        expect(container.querySelector('.katex')).toBeNull();
        expect(container.textContent).toBe('It costs $5 and then $6 more.');
    });

    it('is a div with the block features when not asked for inline', () => {
        const { container } = render(<MarkdownRenderer content={'- one\n- two'} />);
        expect(container.firstElementChild.tagName).toBe('DIV');
        expect(container.querySelectorAll('li')).toHaveLength(2);
    });
});
