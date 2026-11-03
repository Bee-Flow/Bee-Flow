/**
 * An e-mail body is cleaned before it is framed, and the frame cannot open a
 * window outside its sandbox.
 *
 * Run: cd agent-hub && npx vitest run src/components/support/EmailHtmlBody.test.tsx
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';


import EmailHtmlBody, { HEAD_INJECT, measureContentHeight, resolveCidImages } from './EmailHtmlBody';
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

describe('inline cid: images', () => {
    it('swaps cid: for the own file URL, case-insensitive and without <>', () => {
        const out = resolveCidImages('<img src="cid:Logo@X"><img src=\'cid:other\'>', { '<logo@x>': 'blob:abc' });
        expect(out).toContain('<img src="blob:abc">');
        expect(out).toContain("src='cid:other'");
    });

    it('never puts an external URL into the mail', () => {
        const html = '<img src="cid:a">';
        expect(resolveCidImages(html, { a: 'https://evil.example/pixel.gif' })).toBe(html);
        expect(resolveCidImages(html, { a: '/api/studio-apps/x/data/attachments/f' })).toContain('/api/studio-apps/x');
    });

    it('survives the sanitizer inside the frame', () => {
        const { container } = render(<EmailHtmlBody html={'<p>Hi</p><img src="cid:a">'} inlineImages={{ a: 'blob:abc' }} />);
        expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('src="blob:abc"');
    });
});

describe('content height', () => {
    it('forces html/body to auto height in the injected CSS and the frame', () => {
        expect(HEAD_INJECT).toMatch(/html,body\{height:auto !important;min-height:0 !important\}/);
        const { container } = render(<EmailHtmlBody html={'<body style="min-height:100vh"><p>Hi</p></body>'} />);
        expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('min-height:0 !important');
    });

    it('measures the body box, not documentElement.scrollHeight', () => {
        const doc = document.implementation.createHTMLDocument('x');
        Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 2000, configurable: true });
        Object.defineProperty(doc.body, 'scrollHeight', { value: 2000, configurable: true });
        doc.body.getBoundingClientRect = () => ({ height: 300.2 }) as DOMRect;
        expect(measureContentHeight(doc)).toBe(301);
    });

    it('collapses before measuring, and re-measures on every toggle', async () => {
        const html = '<p>Hello</p><blockquote type="cite"><p>old</p></blockquote>';
        const { container } = render(<EmailHtmlBody html={html} />);
        const frame = container.querySelector('iframe') as HTMLIFrameElement;
        const doc = frame.contentDocument as Document;
        doc.open(); doc.write(frame.getAttribute('srcdoc') || ''); doc.close();
        // jsdom has no layout: the body is tall while the quote is visible.
        doc.body.getBoundingClientRect = () => {
            const hidden = doc.querySelector('blockquote')?.hasAttribute('data-bf-quote-hidden');
            return { height: hidden ? 100 : 900 } as DOMRect;
        };
        fireEvent.load(frame);
        await waitFor(() => expect(frame.style.height).toBe('104px'));
        const toggle = doc.querySelector('[data-bf-quote-toggle]') as HTMLElement;
        toggle.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true }));
        await waitFor(() => expect(frame.style.height).toBe('904px'));
        toggle.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true }));
        await waitFor(() => expect(frame.style.height).toBe('104px'));
    });
});
