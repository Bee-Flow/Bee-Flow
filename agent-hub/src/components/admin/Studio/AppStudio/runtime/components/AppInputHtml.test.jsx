import { render } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';
import AppInputHtml, { cleanPastedHtml } from './AppInputHtml';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';
import AppForm from './AppForm';

/**
 * The editor for text that leaves the building.
 *
 * Its value is HTML, which is what makes a signature with a logo and a reply in
 * the company typeface possible at all — and what makes PASTE the interesting
 * part. A paste out of Word or Outlook drags in <style> blocks, class names,
 * MSO conditionals and occasionally a script. The server sanitizer
 * (services/email/send.js) is the security boundary; this pass is what keeps
 * what you see while typing equal to what the recipient gets.
 */

describe('cleanPastedHtml', () => {
    it('keeps the formatting a mail is actually made of', () => {
        const out = cleanPastedHtml(
            '<p style="color:#b91c1c;font-family:Calibri">Beste <b>Jan</b>,</p>'
            + '<ul><li>punt</li></ul>'
            + '<a href="https://beeflow.nl" target="_blank">site</a>',
        );
        expect(out).toContain('style="color:#b91c1c;font-family:Calibri"');
        expect(out).toContain('<b>Jan</b>');
        expect(out).toContain('<li>punt</li>');
        expect(out).toContain('href="https://beeflow.nl"');
    });

    it('unwraps a disallowed element instead of eating the sentence inside it', () => {
        // A <span class=…> around a sentence should lose the span, not the text.
        // That distinction is why this walks the DOM rather than deleting nodes.
        const out = cleanPastedHtml('<section><p>blijft staan</p></section>');
        expect(out).toContain('blijft staan');
        expect(out).not.toContain('<section');
    });

    it('drops what Word brings and mail clients throw away anyway', () => {
        const word = '<style>.MsoNormal{color:red}</style>'
            + '<!--[if gte mso 9]><xml>junk</xml><![endif]-->'
            + '<p class="MsoNormal" style="margin:0">Tekst</p>';
        const out = cleanPastedHtml(word);
        expect(out).not.toMatch(/<style/i);
        expect(out).not.toMatch(/MsoNormal/);
        expect(out).not.toMatch(/<!--/);
        expect(out).toContain('Tekst');
        expect(out).toContain('style="margin:0"'); // inline style is the one that survives
    });

    it('removes the things a regex sanitizer misses', () => {
        for (const [markup, gone] of [
            ['<img src=x onerror="alert(1)">', /onerror/i],
            ['<script>evil()</script><b>ok</b>', /script/i],
            ['<base href="http://evil/">', /<base/i],
            ['<iframe src="http://evil"></iframe>', /iframe/i],
            ['<a href="javascript:alert(1)">klik</a>', /javascript:/i],
        ]) {
            expect(cleanPastedHtml(markup), markup).not.toMatch(gone);
        }
    });

    it('leaves a signature logo usable, by cid or data URI', () => {
        expect(cleanPastedHtml('<img src="cid:logo1" alt="l">')).toContain('cid:logo1');
        expect(cleanPastedHtml('<img src="data:image/png;base64,iVBOR" alt="l">')).toContain('data:image/png');
    });

    it('is empty for empty input rather than throwing', () => {
        for (const v of ['', '   ', null, undefined, 42]) expect(cleanPastedHtml(v)).toBe('');
    });
});

describe('AppInputHtml', () => {
    const node = (props = {}) => ({
        id: 'cmp_html',
        type: 'input_html',
        visible: true,
        props: { name: 'body', label: 'Jouw antwoord', required: false, minRows: 8, allowImages: false, ...props },
        style: { span: 12 },
    });

    const renderField = (n) => render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run' }}>
            <AppForm node={{ id: 'cmp_f', type: 'form', props: { name: 'reply' }, style: { span: 12 }, children: [n] }}>
                <AppInputHtml node={n} />
            </AppForm>
        </RuntimeProvider>,
    );

    it('submits its value as HTML through a hidden input, so a plain POST still finds it', () => {
        const { container } = renderField(node({ defaultValue: '<p>Hallo</p>' }));
        const hidden = container.querySelector('input[type="hidden"][name="body"]');
        expect(hidden).toBeTruthy();
        expect(hidden.value).toBe('<p>Hallo</p>');
    });

    it('renders the default content as real formatting, not as escaped tags', () => {
        const { container } = renderField(node({ defaultValue: '<p>Hallo <b>wereld</b></p>' }));
        const box = container.querySelector('[data-app-html-editor="true"]');
        expect(box.querySelector('b')?.textContent).toBe('wereld');
        expect(box.textContent).not.toContain('<b>');
    });

    it('cleans an incoming value the same way a paste is cleaned', () => {
        // valueFrom and the AI-draft button both push straight into the box.
        const { container } = renderField(node({ defaultValue: '<script>evil()</script><p>ok</p>' }));
        const box = container.querySelector('[data-app-html-editor="true"]');
        expect(box.innerHTML).not.toMatch(/script/i);
        expect(box.textContent).toContain('ok');
    });

    it('offers colour, typeface and size — the reason this component exists', () => {
        const { container } = renderField(node());
        const labels = [...container.querySelectorAll('select')].map((s) => s.getAttribute('aria-label'));
        expect(labels).toEqual(expect.arrayContaining(['Lettertype', 'Grootte', 'Kleur']));
    });

    it('hides the image button unless the form asked for images', () => {
        const off = renderField(node({ allowImages: false }));
        expect(off.container.querySelector('[aria-label="Afbeelding"]')).toBeNull();
        expect(off.container.querySelector('input[type="file"]')).toBeNull();

        const on = renderField(node({ allowImages: true }));
        expect(on.container.querySelector('[aria-label="Afbeelding"]')).toBeTruthy();
    });

    it('grows with minRows so a mail body is not written through a letterbox', () => {
        const { container } = renderField(node({ minRows: 12 }));
        const box = container.querySelector('[data-app-html-editor="true"]');
        expect(box.style.minHeight).toBe('18rem');
    });

    it('carries the placeholder the author wrote, not a hardcoded one', () => {
        const { container } = renderField(node({ placeholder: 'Schrijf een antwoord…' }));
        const box = container.querySelector('[data-app-html-editor="true"]');
        expect(box.getAttribute('data-placeholder')).toBe('Schrijf een antwoord…');
    });
});
