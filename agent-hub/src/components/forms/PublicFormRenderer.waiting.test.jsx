/**
 * FormWaitingView — the screen between two questions of a multi-page form.
 *
 * This is where a visitor spends most of a routine's runtime, and it used to be
 * a spinner and the words "Just a moment…" on the page's bare background. Two
 * things are pinned here:
 *
 *   • it says WHERE the routine is, with the node it is on as the headline and
 *     the flowlets around it as context — one grey run-on line told the visitor
 *     nothing at a glance;
 *   • it says it in TITLES ONLY. The page is served to anonymous visitors, so
 *     no ids, no step types, nothing but the labels the poll sent.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormWaitingView } from './PublicFormRenderer';

describe('FormWaitingView', () => {
    it('makes the node it is on the headline, and the flowlet its context', () => {
        render(<FormWaitingView progress={['9. Blog schrijven en optimaliseren', '3. SEO-optimalisatie']} />);
        // Both are readable, and they are separate elements — not one joined line.
        const step = screen.getByText('3. SEO-optimalisatie');
        const flowlet = screen.getByText('9. Blog schrijven en optimaliseren');
        expect(step).not.toBe(flowlet);
        expect(step.className).toMatch(/font-semibold/);
    });

    it('keeps a nested flowlet path together above the step', () => {
        render(<FormWaitingView progress={['Outer', 'Inner', 'The step']} />);
        expect(screen.getByText('Outer › Inner')).toBeTruthy();
        expect(screen.getByText('The step')).toBeTruthy();
    });

    it('still says something before the first step is known', () => {
        render(<FormWaitingView progress={null} />);
        expect(screen.getByText(/Working on it/)).toBeTruthy();
    });

    it('is a surface, not text on the page — and announces itself', () => {
        // A full-bleed dark page with two lines of grey text on it reads as a
        // page that failed to load.
        const { container } = render(<FormWaitingView progress={['A', 'B']} />);
        const card = container.querySelector('[data-testid="form-waiting"] > div');
        expect(card.className).toContain('border');
        expect(container.querySelector('[data-testid="form-waiting"]').getAttribute('role')).toBe('status');
    });

    it('renders nothing but the titles it was given', () => {
        const { container } = render(<FormWaitingView progress={['7. Wat scoort er al', 'Google-resultaten ophalen']} />);
        const text = container.textContent;
        for (const leak of ['cl1', 'call_layer', 'integration_action', 'run-']) {
            expect(text).not.toContain(leak);
        }
    });

    it('drops empty segments rather than rendering a stray separator', () => {
        render(<FormWaitingView progress={['', null, 'Only one']} />);
        expect(screen.getByText('Only one')).toBeTruthy();
        expect(screen.queryByText('›')).toBeNull();
    });

    /**
     * A flowlet's own one-line description, when it has one. The name says
     * where the routine is; this says what it is doing, which is what makes a
     * ninety-second wait read as work rather than as a hang.
     */
    describe('the description of the running flowlet', () => {
        const DESC = 'Searches Google for a given term and lets AI analyse top-ranking pages.';

        it('shows it under the step it belongs to', () => {
            render(<FormWaitingView progress={['7. Wat scoort er al', 'Google-resultaten ophalen']} note={DESC} />);
            expect(screen.getByText(DESC)).toBeTruthy();
            // The headline is still the step — the description explains it,
            // it does not replace it.
            expect(screen.getByText('Google-resultaten ophalen').className).toMatch(/font-semibold/);
        });

        it('keeps the reassurance line, quieter, so the wait still reads as expected', () => {
            render(<FormWaitingView progress={['A', 'B']} note={DESC} />);
            const reassurance = screen.getByText(/this can take a moment/);
            expect(reassurance.style.color).toBe('var(--text-tertiary)');
        });

        it('leaves the view exactly as it was when the flowlet has no description', () => {
            render(<FormWaitingView progress={['A', 'B']} />);
            expect(screen.queryByTestId('form-waiting-note')).toBeNull();
            expect(screen.getByText(/this can take a moment/).style.color).toBe('var(--text-secondary)');
        });

        it('ignores a blank one rather than opening an empty line for it', () => {
            render(<FormWaitingView progress={['A', 'B']} note="   " />);
            expect(screen.queryByTestId('form-waiting-note')).toBeNull();
        });
    });
});
