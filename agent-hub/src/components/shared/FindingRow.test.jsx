import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import FindingRow from './FindingRow.jsx';

/**
 * The shared "this needs a person" row.
 *
 * Several surfaces draw it (the floating validation pill over the automation
 * canvas, the attention list on Studio Home, the Compliance drawers), so what
 * is pinned here is exactly what changes once someone rebuilds it:
 *
 *   1. THREE tones, not two. The pill only knew error/warning; 'info' is the
 *      one new behaviour of the extraction, and advice drawn in a warning's
 *      colour is advice that reads as a warning;
 *   2. the machine code is there, because a support answer quotes it;
 *   3. a row that opens something is a BUTTON with a keyboard; a row that
 *      opens nothing is plain text;
 *   4. size "sm" is 12px with the text in the tone's ink, the border and
 *      tint still raw; the default size is unchanged.
 */
describe('FindingRow', () => {
    beforeEach(cleanup);

    const bg = (el) => el.getAttribute('style') || '';

    it('gives every severity its own colour; advice is neutral, not orange', () => {
        const { rerender } = render(<FindingRow severity="error" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--error/);
        rerender(<FindingRow severity="warning" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--warning/);
        rerender(<FindingRow severity="info" message="x" testId="r" />);
        const info = bg(screen.getByTestId('r'));
        expect(info).toMatch(/--text-tertiary/);
        expect(info).not.toMatch(/--warning/);
    });

    it('falls back to the warning tone for a severity it does not know', () => {
        render(<FindingRow severity="whatever" message="x" testId="r" />);
        expect(bg(screen.getByTestId('r'))).toMatch(/--warning/);
    });

    it('shows the machine code, the label, the sentence and the fix on its own line', () => {
        render(<FindingRow code="app.screens.missing" label="Order portal" message="Has no screens." hint="Add one." testId="r" />);
        const row = screen.getByTestId('r');
        expect(row.textContent).toContain('app.screens.missing');
        expect(row.textContent).toContain('Order portal');
        expect(row.textContent).toContain('Has no screens.');
        expect(row.textContent).toContain('→ Add one.');
    });

    it('is a keyboard button when there is something to open, and text otherwise', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        const { rerender } = render(<FindingRow message="x" onOpen={onOpen} openLabel="Show me" testId="r" />);
        const row = screen.getByTestId('r');
        expect(row.getAttribute('role')).toBe('button');
        expect(row.getAttribute('tabindex')).toBe('0');
        await user.tab();
        await user.keyboard('{Enter}');
        await user.click(row);
        expect(onOpen).toHaveBeenCalledTimes(2);

        rerender(<FindingRow message="x" testId="r" />);
        expect(screen.getByTestId('r').getAttribute('role')).toBeNull();
    });

    it('carries the severity as a data attribute, so a list can sort and test on it', () => {
        render(<FindingRow severity="info" message="x" testId="r" />);
        expect(screen.getByTestId('r').getAttribute('data-severity')).toBe('info');
    });

    it('size sm: text-xs leading-snug, text in the tone ink, border and tint still raw', () => {
        const { rerender } = render(<FindingRow severity="warning" size="sm" message="No DPA on file." testId="r" />);
        let row = screen.getByTestId('r');
        expect(row.className).toContain('text-xs leading-snug');
        expect(row.dataset.size).toBe('sm');
        expect(row.style.background).toBe('color-mix(in srgb, var(--warning) 5%, transparent)');
        expect(bg(row)).toMatch(/color-mix\(in srgb, var\(--warning\) 20%, transparent\)/);
        expect(row.firstElementChild.style.color).toBe('var(--warning-ink)');
        rerender(<FindingRow severity="error" size="sm" message="x" testId="r" />);
        row = screen.getByTestId('r');
        expect(row.firstElementChild.style.color).toBe('var(--error-ink)');
        expect(row.style.background).toBe('color-mix(in srgb, var(--error) 5%, transparent)');
    });

    it('the default size is unchanged for the builder and Studio callers', () => {
        render(<FindingRow severity="warning" message="x" testId="r" />);
        const row = screen.getByTestId('r');
        expect(row.className).not.toContain('text-xs');
        expect(row.dataset.size).toBeUndefined();
        expect(row.firstElementChild.style.color).toBe('var(--warning)');
    });
});
