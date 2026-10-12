import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import MismatchResolver from './MismatchResolver';

/**
 * The inline "it doesn't fit" box (artboard 2a): a sentence in plain words,
 * the applied choice as a chip, and the full choice list behind a progressive
 * "List options" disclosure (BFSF-482) — "more" sits one level deeper still.
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

const expandOptions = () => fireEvent.click(screen.getByRole('button', { name: 'List options' }));

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

    it('opens collapsed: the applied choice is a chip, the choice list stays out of sight (BFSF-482)', () => {
        renderBox();
        // What the field NOW holds is plain at a glance…
        expect(screen.getByTestId('mismatch-selected').textContent).toBe('All of them, one per line');
        // …and the other choices are behind the disclosure, not on screen.
        expect(screen.queryByRole('button', { name: 'Only the first' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'A separate run for each item' })).toBeNull();
        expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'List options' }).getAttribute('aria-expanded')).toBe('false');
    });

    it('offers the four choices in the design order once "List options" is opened, the applied one selected', () => {
        renderBox();
        expandOptions();
        const labels = ['All of them, one per line', 'Only the first', 'Only the count (2)', 'A separate run for each item'];
        for (const l of labels) expect(screen.getByRole('button', { name: l })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'All of them, one per line' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Only the first' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('a choice hands back the binding it writes, and the collapsed summary follows it', () => {
        const { onChoose } = renderBox();
        expandOptions();
        fireEvent.click(screen.getByRole('button', { name: 'Only the first' }));
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'first', binding: { kind: 'expr', value: 'first(steps.a.output.warnings)' } }));
        fireEvent.click(screen.getByRole('button', { name: 'A separate run for each item' }));
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ id: 'foreach', forEach: expect.objectContaining({ overRef: 'steps.a.output.warnings' }) }));
        // Collapse again: the summary names the last applied choice.
        fireEvent.click(screen.getByRole('button', { name: 'fewer' }));
        expect(screen.queryByRole('button', { name: 'Only the first' })).toBeNull();
    });

    it('keeps "the whole list" two clicks away, never gone', () => {
        renderBox();
        expect(screen.queryByRole('button', { name: 'Keep the whole list' })).toBeNull();
        expandOptions();
        expect(screen.queryByRole('button', { name: 'Keep the whole list' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /more/ }));
        expect(screen.getByRole('button', { name: 'Keep the whole list' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Only the last' })).toBeTruthy();
    });

    it('names the disclosure for the kind that was picked', () => {
        renderBox({ actualKind: 'table' });
        expect(screen.getByRole('button', { name: 'Table options' })).toBeTruthy();
        cleanup();
        renderBox({ actualKind: 'group' });
        expect(screen.getByRole('button', { name: 'Field options' })).toBeTruthy();
    });

    it('the collapsed summary can name a choice that lives behind "more"', () => {
        // BindingField's "choose how to use the list" enters on `each`.
        renderBox({ selectedId: 'each' });
        expect(screen.getByTestId('mismatch-selected').textContent).toBe('Keep the whole list');
    });

    it('leaves out the per-item run when the host cannot offer it', () => {
        renderBox({ allowForEach: false });
        expandOptions();
        expect(screen.queryByRole('button', { name: 'A separate run for each item' })).toBeNull();
    });

    it('can be closed once the author is happy', () => {
        const onClose = vi.fn();
        renderBox({ onClose });
        fireEvent.click(screen.getByLabelText('Cancel'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
