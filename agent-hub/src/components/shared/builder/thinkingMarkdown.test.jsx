import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { currentThought, renderThinking } from './thinkingMarkdown';

/** Lines lifted verbatim from a real local-model build of the ticket brief. */
const REAL = `The user wants a routine that runs every weekday at 08:00.
1. Fetch JSON from \`https://example.org/api/tickets\`.
2. Filter tickets with \`priority === "high"\`.
3. Count them.

Let's break it down:
- Trigger: Schedule, \`0 8 * * 1-5\`, \`Europe/Amsterdam\`.
- Step 1: HTTP Request to \`https://example.org/api/tickets\`.

Wait, the HTTP request might fail. I need to wire an error branch.`;

const html = (node) => {
    const { container } = render(<div>{node}</div>);
    return container;
};

describe('renderThinking', () => {
    it('turns the real reasoning into structure, not literal punctuation', () => {
        const c = html(renderThinking(REAL));
        expect(c.querySelectorAll('ol')).toHaveLength(1);
        expect(c.querySelectorAll('ul')).toHaveLength(1);
        expect(c.querySelectorAll('ol li')).toHaveLength(3);
        expect(c.querySelectorAll('ul li')).toHaveLength(2);
        expect(c.querySelectorAll('code').length).toBeGreaterThan(4);
        // The markers themselves must be gone from the visible text.
        expect(c.textContent).not.toContain('`');
        expect(c.textContent).not.toContain('1. ');
    });

    it('keeps a cron expression intact instead of reading its stars as italics', () => {
        // `0 8 * * 1-5` is the case that decides code-before-emphasis ordering.
        const c = html(renderThinking('Trigger: `0 8 * * 1-5` on weekdays.'));
        expect(c.querySelector('code').textContent).toBe('0 8 * * 1-5');
        expect(c.querySelectorAll('em')).toHaveLength(0);
    });

    it('leaves a half-streamed marker as plain text', () => {
        // Every one of these is a normal intermediate state mid-stream.
        for (const partial of ['I will call `builder_add', 'This is **impor', 'a * b is fine']) {
            const c = html(renderThinking(partial));
            expect(c.querySelectorAll('code')).toHaveLength(0);
            expect(c.textContent).toContain(partial.slice(-4));
        }
    });

    it('does not read [Output Generation] as a link', () => {
        const c = html(renderThinking('[Output Generation] -> calls tools.'));
        expect(c.querySelectorAll('a')).toHaveLength(0);
        expect(c.textContent).toContain('[Output Generation]');
    });

    it('renders bold and italic', () => {
        const c = html(renderThinking('This is **bold** and *italic*.'));
        expect(c.querySelector('strong').textContent).toBe('bold');
        expect(c.querySelector('em').textContent).toBe('italic');
    });

    it('splits a bullet list that turns into a numbered one', () => {
        const c = html(renderThinking('- one\n- two\n1. first\n2. second'));
        expect(c.querySelectorAll('ul')).toHaveLength(1);
        expect(c.querySelectorAll('ol')).toHaveLength(1);
    });

    it('returns null for nothing at all', () => {
        expect(renderThinking('')).toBeNull();
        expect(renderThinking('   \n  ')).toBeNull();
        expect(renderThinking(null)).toBeNull();
    });

    it('emits React elements only — no raw HTML is ever injected', () => {
        const c = html(renderThinking('<img src=x onerror=alert(1)> and `<b>hi</b>`'));
        expect(c.querySelectorAll('img')).toHaveLength(0);
        expect(c.querySelectorAll('b')).toHaveLength(0);
        expect(c.textContent).toContain('<img src=x');
    });
});

describe('currentThought', () => {
    it('reports the latest line that actually says something', () => {
        expect(currentThought(REAL)).toBe('Wait, the HTTP request might fail. I need to wire an error branch.');
    });

    it('walks back past fragments a half-streamed line leaves behind', () => {
        expect(currentThought('Filtering the high priority tickets now.\nWait,')).toBe(
            'Filtering the high priority tickets now.');
    });

    it('strips list markers and code fences from the line it picks', () => {
        expect(currentThought('- Step 1: HTTP Request to `the endpoint`.')).toBe(
            'Step 1: HTTP Request to the endpoint.');
    });

    it('truncates on a word boundary, never mid-word', () => {
        const out = currentThought('a'.repeat(3) + ' ' + 'verylongwordindeed '.repeat(8), 40);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(41);
        expect(out).not.toMatch(/verylongwordinde…$/);
    });

    it('is empty when there is nothing worth saying', () => {
        expect(currentThought('')).toBe('');
        expect(currentThought('Yes.')).toBe('');
    });
});

// The 2026-09-13 trace: Gemma 4 wrote its fourth call as text inside the
// thought channel. The block showed "appuserttable" in italics with raw
// <|"> tokens between the words.
const GEMMA_CALL = '<|tool_call>call:app_upsert_table{fields:[{key:<|">name<|">,type:<|">text<|">},{key:<|">contact_person<|">,type:<|">text<|">}],name:<|">suppliers<|">}<tool_call|>';

describe('renderThinking — a call written as text', () => {
    it('keeps snake_case names whole: an underscore inside a word is never emphasis', () => {
        const c = html(renderThinking('I will call app_upsert_table with contact_person next.'));
        expect(c.querySelectorAll('em')).toHaveLength(0);
        expect(c.textContent).toBe('I will call app_upsert_table with contact_person next.');
        // Real emphasis still works when the underscores stand alone.
        const e = html(renderThinking('this is _really_ needed'));
        expect(e.querySelector('em').textContent).toBe('really');
    });

    it('renders the Gemma wire syntax as one code block — tokens gone, fences as quotes, name first', () => {
        const c = html(renderThinking(`A suppliers table first.\n${GEMMA_CALL}\nThen invoices.`));
        const pre = c.querySelector('pre[data-thinking-call="app_upsert_table"]');
        expect(pre).not.toBeNull();
        expect(pre.textContent).toBe('→ app_upsert_table{fields:[{key:"name",type:"text"},{key:"contact_person",type:"text"}],name:"suppliers"}');
        expect(c.textContent).not.toContain('<|');
        expect(c.textContent).not.toContain('tool_call');
        expect(c.querySelectorAll('em')).toHaveLength(0);
        // The prose around it is still prose, in order.
        const ps = [...c.querySelectorAll('p')].map((p) => p.textContent);
        expect(ps).toEqual(['A suppliers table first.', 'Then invoices.']);
        expect(c.firstChild.children[0].tagName).toBe('P');
        expect(c.firstChild.children[1].tagName).toBe('PRE');
    });

    it('shows a call still being typed as the same block, growing, and never leaks half a token', () => {
        const partial = html(renderThinking('<|tool_call>call:app_upsert_ta'));
        const pre = partial.querySelector('pre');
        expect(pre.getAttribute('data-thinking-call')).toBe('app_upsert_ta');
        expect(pre.textContent).toBe('→ app_upsert_ta');
        const opener = html(renderThinking('<|tool_call>'));
        expect(opener.querySelector('pre').getAttribute('data-thinking-call')).toBe('partial');
        expect(opener.textContent).toBe('→ ');
    });

    it('reads the Hermes/Qwen syntax too', () => {
        const c = html(renderThinking('<tool_call>\n{"name": "app_set_meta", "arguments": {"name": "X"}}\n</tool_call>'));
        const pre = c.querySelector('pre[data-thinking-call="app_set_meta"]');
        expect(pre.textContent).toBe('→ {"name": "app_set_meta", "arguments": {"name": "X"}}');
    });
});

describe('currentThought — a call being written', () => {
    it('names the tool instead of showing a line of tokens', () => {
        expect(currentThought(`Let me add the suppliers table first.\n${GEMMA_CALL}`)).toBe('→ app_upsert_table');
        expect(currentThought('Thinking about tables.\n<|tool_call>call:app_up')).toBe('→ app_up');
        expect(currentThought('<|tool_call>')).toBe('→ …');
    });

    it('goes back to the prose once the call is followed by more reasoning', () => {
        expect(currentThought(`${GEMMA_CALL}\nNow the invoices table needs a supplier link.`)).toBe('Now the invoices table needs a supplier link.');
    });
});
