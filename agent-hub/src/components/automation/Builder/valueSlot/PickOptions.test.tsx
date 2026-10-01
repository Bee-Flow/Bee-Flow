import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MappingSource } from '@shared/mapping/index.mjs';
import PickOptions, { previewText, resolvePreview } from './PickOptions';

const LINES = [
    { product: 'Stoel', qty: 1, price: 99.5 },
    { product: 'Lamp', qty: 2, price: 15 },
    { product: 'Muismat', qty: 3, price: 5 },
];
const SAMPLE = { trigger: { output: { order: { lines: LINES } } }, steps: {} };
const PRODUCT: MappingSource = { root: 'trigger', path: ['order', 'lines', 'product'] };
const LINES_SOURCE: MappingSource = { root: 'trigger', path: ['order', 'lines'] };
const TEXT = { as: 'text' as const, multiLine: true };

const optionTexts = () => screen.getAllByRole('radio').map(r => [
    r.getAttribute('data-option'),
    within(r).getByTestId('option-preview').textContent,
]);

describe('PickOptions', () => {
    it('a list into text: every option with a live preview, the default first and chosen', () => {
        render(<PickOptions source={PRODUCT} sample={SAMPLE} slot={TEXT} label="Product of all lines" onSelect={() => {}} />);
        expect(screen.getByText('How should Product of all lines be used?')).toBeInTheDocument();
        expect(optionTexts()).toEqual([
            ['all_lines', 'Stoel\nLamp\nMuismat'],
            ['all_comma', 'Stoel, Lamp, Muismat'],
            ['all_bullets', '- Stoel\n- Lamp\n- Muismat'],
            ['first', 'Stoel'],
            ['last', 'Muismat'],
            ['count', '3'],
        ]);
        expect(screen.getByRole('radio', { name: /All, one per line/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    });

    it('choosing an option hands back its intent', async () => {
        const onSelect = vi.fn();
        render(<PickOptions source={PRODUCT} sample={SAMPLE} slot={TEXT} value={{ take: 'all', as: 'text', join: 'lines' }} onSelect={onSelect} />);
        await userEvent.click(screen.getByRole('radio', { name: /All, with commas/ }));
        expect(onSelect).toHaveBeenCalledWith({ take: 'all', as: 'text', join: 'comma' });
        await userEvent.click(screen.getByRole('radio', { name: /Only the last/ }));
        expect(onSelect).toHaveBeenLastCalledWith({ take: 'last', as: 'text' });
    });

    it('the current choice is marked, whichever it is', () => {
        render(<PickOptions source={PRODUCT} sample={SAMPLE} slot={TEXT} value={{ take: 'count', as: 'text' }} onSelect={() => {}} />);
        expect(screen.getByRole('radio', { name: /The number/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: /All, one per line/ })).toHaveAttribute('aria-checked', 'false');
    });

    it('a table into text previews one readable line per row, never JSON', () => {
        render(<PickOptions source={LINES_SOURCE} sample={SAMPLE} slot={TEXT} onSelect={() => {}} />);
        const all = within(screen.getByRole('radio', { name: /All, one per line/ })).getByTestId('option-preview');
        expect(all.textContent).toBe('Stoel · 1 · 99.5\nLamp · 2 · 15\nMuismat · 3 · 5');
        expect(screen.getByTestId('pick-options').textContent).not.toMatch(/\{|\[object Object\]/);
    });

    it('many values into a number field: no "all", the first by default', () => {
        render(<PickOptions source={{ root: 'trigger', path: ['order', 'lines', 'price'] }} sample={SAMPLE} slot={{ as: 'number' }} onSelect={() => {}} />);
        expect(optionTexts()).toEqual([['first', '99.5'], ['last', '5'], ['count', '3']]);
        expect(screen.getByRole('radio', { name: /Only the first/ })).toHaveAttribute('aria-checked', 'true');
    });

    it('without a sample there is no example yet; one value has one option', () => {
        render(<PickOptions source={PRODUCT} shape="list" slot={TEXT} onSelect={() => {}} />);
        expect(screen.getAllByText('No example yet')).toHaveLength(6);
    });

});

describe('PickOptions: regressions', () => {
    /**
     * REGRESSION (confirmed bug "A list with no sample data defaults to
     * join(), which gives '[object Object]' once real data holds objects"),
     * the editor's half: before a run the list is empty, the pick is stored
     * with the text default, and the previews (and the run) render what the
     * data holds when it arrives: rows, not "[object Object]".
     */
    it('a list that was empty before the run renders its records as rows once they are there', () => {
        const before = { trigger: { output: { order: { lines: [] } } } };
        const { rerender } = render(<PickOptions source={LINES_SOURCE} sample={before} slot={TEXT} onSelect={() => {}} />);
        const first = screen.getAllByRole('radio')[0];
        expect(first).toHaveAttribute('data-option', 'all_lines');
        expect(within(first).getByTestId('option-preview').textContent).toBe('(empty)');
        rerender(<PickOptions source={LINES_SOURCE} sample={SAMPLE} slot={TEXT} onSelect={() => {}} />);
        expect(screen.getByTestId('pick-options').textContent).not.toContain('[object Object]');
        expect(within(screen.getAllByRole('radio')[0]).getByTestId('option-preview').textContent).toContain('Stoel · 1 · 99.5');
    });

    /**
     * REGRESSION (confirmed bug "The inline resolver box goes stale after the
     * field is edited and can overwrite new content"), the building block's
     * half: the options hold no copy of what they describe. A new source or
     * sample re-renders every preview; the choice they hand back is only the
     * intent, applied by the caller to the field as it is then.
     */
    it('the previews follow the props, so they can never describe an older value', () => {
        const { rerender } = render(<PickOptions source={PRODUCT} sample={SAMPLE} slot={TEXT} onSelect={() => {}} />);
        expect(within(screen.getAllByRole('radio')[0]).getByTestId('option-preview').textContent).toBe('Stoel\nLamp\nMuismat');
        rerender(<PickOptions source={{ root: 'trigger', path: ['order', 'lines', 'qty'] }} sample={SAMPLE} slot={TEXT} onSelect={() => {}} />);
        expect(within(screen.getAllByRole('radio')[0]).getByTestId('option-preview').textContent).toBe('1\n2\n3');
    });

});

describe('PickOptions: Advanced and repeat', () => {
    it('Advanced: formula, exactly one row, and the repeat shortcut when wired', async () => {
        const onFormula = vi.fn();
        const onRowIndex = vi.fn();
        const onRepeatShortcut = vi.fn();
        render(
            <PickOptions
                source={PRODUCT} sample={SAMPLE} slot={TEXT} onSelect={() => {}}
                onFormula={onFormula} onRowIndex={onRowIndex} onRepeatShortcut={onRepeatShortcut}
            />,
        );
        const toggle = screen.getByRole('button', { name: 'Advanced' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: 'Write a formula instead' })).not.toBeInTheDocument();
        await userEvent.click(toggle);
        await userEvent.click(screen.getByRole('button', { name: 'Write a formula instead' }));
        expect(onFormula).toHaveBeenCalledTimes(1);
        const row = screen.getByRole('spinbutton', { name: 'Exactly this row' });
        await userEvent.clear(row);
        await userEvent.type(row, '3');
        await userEvent.click(screen.getByRole('button', { name: 'Use row' }));
        expect(onRowIndex).toHaveBeenCalledWith(2);
        await userEvent.click(screen.getByRole('button', { name: 'Run this step separately for each item' }));
        expect(onRepeatShortcut).toHaveBeenCalledTimes(1);
    });

    it('a repeated step offers "for each item" first, without a preview', () => {
        render(<PickOptions source={PRODUCT} sample={SAMPLE} slot={TEXT} repeating onSelect={() => {}} />);
        const first = screen.getAllByRole('radio')[0];
        expect(first).toHaveAttribute('data-option', 'each');
        expect(within(first).queryByTestId('option-preview')).not.toBeInTheDocument();
    });
});

describe('previewText and resolvePreview', () => {
    it('render values the way a person reads them', () => {
        expect(previewText(undefined)).toBeNull();
        expect(previewText(null)).toBe('');
        expect(previewText(3)).toBe('3');
        expect(previewText(['a', { b: 1, c: 2 }])).toBe('a, 1 · 2');
        expect(previewText({ naam: 'Jan', plaats: 'Utrecht' })).toBe('naam: Jan, plaats: Utrecht');
        expect(previewText('x'.repeat(500))).toHaveLength(160);
    });

    it('resolve through the same core as the run', () => {
        expect(resolvePreview(PRODUCT, { take: 'all', as: 'list' }, SAMPLE)).toEqual(['Stoel', 'Lamp', 'Muismat']);
        expect(resolvePreview(PRODUCT, { take: 'all', as: 'list' }, null)).toBeUndefined();
    });
});
