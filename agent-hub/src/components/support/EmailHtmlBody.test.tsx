/**
 * An e-mail body is cleaned before it is framed, and the frame cannot open a
 * window outside its sandbox.
 *
 * Run: cd agent-hub && npx vitest run src/components/support/EmailHtmlBody.test.tsx
 */
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';


import EmailHtmlBody from './EmailHtmlBody';
import { sanitizeEmailHtml } from './emailHtmlSanitize';

describe('sanitizeEmailHtml', () => {
    it('drops scripts, forms, meta refresh, base and frames, keeps the text', () => {
        const out = sanitizeEmailHtml(
            '<meta http-equiv="refresh" content="0;url=https://x.example"><base href="https://x.example/">'
            + '<p onclick="go()">Hello</p><script>alert(1)</script>'
            + '<form action="https://x.example/steal"><input name="pw"><span>inside</span></form>'
            + '<iframe src="https://x.example"></iframe>',
        );
        expect(out).toContain('Hello');
        expect(out).toContain('inside');
        expect(out).not.toMatch(/<script|<form|<iframe|<base|http-equiv|onclick/i);
    });

    it('removes javascript: and data: links but keeps http(s), mailto and inline images', () => {
        const out = sanitizeEmailHtml(
            '<a id="a" href="javascript:alert(1)">a</a><a id="b" href=" jav&#x09;ascript:x">b</a>'
            + '<a id="c" href="data:text/html,<b>x</b>">c</a><a id="d" href="https://ok.example/">d</a>'
            + '<a id="e" href="mailto:x@example.org">e</a><img src="data:image/png;base64,iVBORw0KGgo=">',
        );
        const doc = new DOMParser().parseFromString(out, 'text/html');
        expect(doc.getElementById('a')?.hasAttribute('href')).toBe(false);
        expect(doc.getElementById('b')?.hasAttribute('href')).toBe(false);
        expect(doc.getElementById('c')?.hasAttribute('href')).toBe(false);
        expect(doc.getElementById('d')?.getAttribute('href')).toBe('https://ok.example/');
        expect(doc.getElementById('e')?.getAttribute('href')).toBe('mailto:x@example.org');
        expect(doc.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/);
    });

    it('keeps a full document a full document, with its styles', () => {
        const out = sanitizeEmailHtml('<!doctype html><html><head><style>p{color:red}</style></head><body><p>x</p></body></html>');
        expect(out).toMatch(/^<!DOCTYPE html><html><head><style>p\{color:red\}<\/style><\/head><body><p>x<\/p><\/body><\/html>$/);
    });
});

describe('EmailHtmlBody', () => {
    it('frames the cleaned body without a popup sandbox escape', () => {
        const { container } = render(<EmailHtmlBody html={'<p>Hi</p><a href="javascript:alert(1)">x</a><meta http-equiv="refresh" content="0">'} />);
        const frame = container.querySelector('iframe');
        const sandbox = frame?.getAttribute('sandbox') || '';
        expect(sandbox).not.toMatch(/allow-popups-to-escape-sandbox|allow-scripts|allow-forms/);
        const srcdoc = frame?.getAttribute('srcdoc') || '';
        expect(srcdoc).toContain('<p>Hi</p>');
        expect(srcdoc).not.toMatch(/javascript:|http-equiv/i);
    });
});
