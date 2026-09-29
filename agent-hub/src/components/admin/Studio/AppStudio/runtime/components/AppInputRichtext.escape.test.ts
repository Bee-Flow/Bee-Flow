import { describe, it, expect } from 'vitest';
import { markdownToHtml, htmlToMarkdown } from './AppInputRichtext';

function render(md: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = markdownToHtml(md);
    return el;
}

describe('AppInputRichtext markdown → HTML escaping', () => {
    it('keeps a quote in a link target inside the href', () => {
        const el = render('[x](https://a"onmouseover="alert(1))');
        const link = el.querySelector('a');
        expect(link).not.toBeNull();
        expect(link!.getAttributeNames()).toEqual(['href']);
        expect(el.querySelector('[onmouseover]')).toBeNull();
    });

    it('does not let a quote in plain text open an attribute', () => {
        const el = render('say "hi" and \'bye\'');
        expect(el.textContent).toBe('say "hi" and \'bye\'');
    });

    it('round-trips a link whose query string has an ampersand', () => {
        const md = '[docs](https://example.com/?a=1&b=2)';
        const el = render(md);
        expect(el.querySelector('a')!.getAttribute('href')).toBe('https://example.com/?a=1&b=2');
        expect(htmlToMarkdown(el)).toBe(md);
    });

    it('drops a javascript: href', () => {
        const el = render('[x](javascript:alert(1))');
        expect(el.querySelector('a')?.getAttribute('href') ?? '').toBe('');
    });
});
