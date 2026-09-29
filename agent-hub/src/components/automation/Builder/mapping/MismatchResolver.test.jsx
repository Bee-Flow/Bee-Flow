import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import MismatchResolver from './MismatchResolver';

/**
 * The inline "it doesn't fit" box (artboard 2a): a sentence in plain words,
 * the four choices, the first one already selected, and "more" for the rest.
 * No portal, no popover — it is part of the form.
 */
const ROOT = { steps: { a: { output: { warnings: ['Column Budget 2026 is empty', 'Row 12 unlabelled'] } } } };
const LABELS = new Map([['a', 'Read the figures']]);

const renderBox = (props = {}) => {
    const onChoose = vi.fn();
    render(
        <MismatchResolver
            path="steps.a.output.warnings"
            sampleRoot={ROOT}
            stepLabelById={LABELS}
            actualKind="list"
            expectedKind="text"
            selectedId="join"
            allowForEach
            onChoose={onChoose}
            {...props}
        />,
    );
    return { onChoose };
};

describe('MismatchResolver', () => {
    beforeEach(cleanup);

    it('says, in words, what does not fit — and names the field by its step', () => {
        renderBox();
        const box = screen.getByTestId('mismatch-resolver');
        expect(box.textContent).toContain('Read the figures ▸ Warnings');
        expect(box.textContent).toContain('is a list of 2, this needs one text. What do you want?');
        expect(box.textContent).not.toMatch(/array|object|string/);
        // Inline: not portalled, not a dialog.
        expect(box.closest('[role="dialog"]')).toBeNull();
    });

    it('offers the four choices in the design order, the first one selected', () => {
        renderBox();
        const labels = ['All of them, one per line', 'Only the first', 'Only the count (2)', 'A separate run for each item'];
        for (const l of labels) expect(screen.getByRole('button', { name: l })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'All of them, one per line' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Only the first' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('a choice hands back the binding it writes', () => {
        const { onChoose } = renderBox();
        fireEvent.click(screen.getByRole('button', { name: 'Only the first' }));
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'first', binding: { kind: 'expr', value: 'first(steps.a.output.warnings)' } }));
        fireEvent.click(screen.getByRole('button', { name: 'A separate run for each item' }));
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'foreach', forEach: expect.objectContaining({ overRef: 'steps.a.output.warnings' }) }));
    });

    it('keeps "the whole list" one click further away, never gone', () => {
        renderBox();
        expect(screen.queryByRole('button', { name: 'Keep the whole list' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /more/ }));
        expect(screen.getByRole('button', { name: 'Keep the whole list' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Only the last' })).toBeTruthy();
    });

    it('leaves out the per-item run when the host cannot offer it', () => {
        renderBox({ allowForEach: false });
        expect(screen.queryByRole('button', { name: 'A separate run for each item' })).toBeNull();
    });

    it('can be closed once the author is happy', () => {
        const onClose = vi.fn();
        renderBox({ onClose });
        fireEvent.click(screen.getByLabelText('Cancel'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
