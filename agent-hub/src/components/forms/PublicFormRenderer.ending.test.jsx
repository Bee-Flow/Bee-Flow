/**
 * FormEndingView — the closing page of a public form.
 *
 * A routine that pauses on a `form_page` step in "ending" mode hands the
 * visitor its actual RESULT there: a document link, the text it just wrote.
 * That description used to render as one flat paragraph, so the visitor read
 * raw `##` and `**` and had to copy a URL out by hand.
 *
 * Two invariants, and the second is the one that matters:
 *   • the description renders as markdown, with real links;
 *   • embedded HTML is NEVER live. The page is served to anonymous visitors
 *     and its text can carry model output, so rehype-raw must stay out.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormEndingView } from './PublicFormRenderer';

const form = (description) => ({ title: 'Klaar', description, theme: {} });

describe('FormEndingView', () => {
    it('renders the description as markdown rather than as literal syntax', () => {
        render(<FormEndingView form={form('## Waterstralen\n\nEen **korte** alinea.')} />);
        expect(screen.getByText('Waterstralen').tagName).toBe('H3');   // h2 → h3 in-page
        expect(screen.getByText('korte').tagName).toBe('STRONG');
        expect(screen.queryByText(/##/)).toBeNull();
    });

    it('turns a markdown link into an anchor that is safe to click', () => {
        render(<FormEndingView form={form('[Open het concept](https://docs.google.com/document/d/abc/edit)')} />);
        const a = screen.getByRole('link', { name: 'Open het concept' });
        expect(a.getAttribute('href')).toBe('https://docs.google.com/document/d/abc/edit');
        expect(a.getAttribute('target')).toBe('_blank');
        // Without noopener the opened tab can reach back through window.opener.
        expect(a.getAttribute('rel')).toContain('noopener');
        expect(a.getAttribute('rel')).toContain('noreferrer');
    });

    it('never turns embedded HTML into live markup', () => {
        const { container } = render(
            <FormEndingView form={form('<img src=x onerror="alert(1)"> <script>alert(2)</script> plain')} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelector('script')).toBeNull();
        expect(container.textContent).toContain('plain');
    });

    it('left-aligns a long closing and keeps a short one centred', () => {
        const { container: short } = render(<FormEndingView form={form('Bedankt!')} />);
        expect(short.querySelector('[data-testid="form-ending"] > div').className).toContain('text-center');

        const { container: long } = render(<FormEndingView form={form('x'.repeat(500))} />);
        expect(long.querySelector('[data-testid="form-ending"] > div').className).toContain('text-left');
    });

    it('still shows the title alone when there is no description', () => {
        render(<FormEndingView form={{ title: 'Bedankt', theme: {} }} />);
        expect(screen.getByText('Bedankt')).toBeTruthy();
    });
});
