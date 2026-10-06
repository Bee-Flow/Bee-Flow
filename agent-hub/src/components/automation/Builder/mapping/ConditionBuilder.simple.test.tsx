/**
 * Simple mode never shows a formula (R8): a rule the rows cannot show reads
 * as a "Custom rule" card naming the fields it reads, with a way back to
 * clicking that leaves the saved formula alone until a field is picked.
 * Advanced keeps the formula box.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConditionBuilderJs from './ConditionBuilder';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { FormDensityContext } from '../flow/settings/formDensity';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const VariablePickerProvider = ProviderJs as unknown as Loose;
const ConditionBuilder = ConditionBuilderJs as unknown as Loose;

const MAIL = { subject: 'Invoice 7', from: 'billing@fabrikam.example' };
const PREVIEW = { item: MAIL };
const OPTIONS = [
    { path: 'item.subject', label: 'Subject', sample: MAIL.subject, group: 'Fields of each message' },
    { path: 'item.from', label: 'From', sample: MAIL.from, group: 'Fields of each message' },
];
const FORMULA = 'lower(item.subject) == "invoice" && item.fields["Story Points"] * 2 > 3';

// The context is declared in JS with `mode: null`; a mode is what this test sets.
const densityIn = (mode: string) => ({ density: 'full', mode, onHiddenSection: null, onShownSection: null }) as unknown as React.ContextType<typeof FormDensityContext>;

function builderIn(mode: 'simple' | 'advanced', value: string, onChange: (expr: string) => void) {
    return (
        <FormDensityContext.Provider value={densityIn(mode)}>
            <VariablePickerProvider groups={[]} previewSample={PREVIEW} stepLabelById={new Map()}>
                <ConditionBuilder value={value} onChange={onChange} context="filter" previewSample={PREVIEW} fieldOptions={OPTIONS} />
            </VariablePickerProvider>
        </FormDensityContext.Provider>
    );
}

function renderIn(mode: 'simple' | 'advanced', value: string) {
    const onChange = vi.fn();
    const { rerender } = render(builderIn(mode, value, onChange));
    return { onChange, switchTo: (next: 'simple' | 'advanced') => rerender(builderIn(next, value, onChange)) };
}

describe('ConditionBuilder in Simple mode', () => {
    afterEach(() => cleanup());

    it('shows a formula as a Custom rule card naming its fields, never the formula', () => {
        renderIn('simple', FORMULA);
        expect(screen.getByText('Custom rule')).toBeTruthy();
        expect(screen.getByText('This rule is written as a formula, so it can’t be shown as clickable rows here.')).toBeTruthy();
        const reads = screen.getByText(/^It reads: /).textContent || '';
        expect(reads).toContain('Subject');
        // Named the way the rows and the canvas name it (humanizeFieldTail).
        expect(reads.toLowerCase()).toContain('story points');
        expect(reads).not.toContain('item.');
        expect(reads).not.toContain('lower');
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByText(FORMULA)).toBeNull();
        expect(screen.getByText('To change the formula itself, switch to Advanced.')).toBeTruthy();
    });

    it('"Build it again by clicking" shows one empty row and keeps the formula until a field is picked', async () => {
        const user = userEvent.setup();
        const { onChange } = renderIn('simple', FORMULA);
        await user.click(screen.getByRole('button', { name: 'Build it again by clicking' }));
        expect(screen.getByRole('button', { name: /Choose a field/ })).toBeTruthy();
        expect(screen.getByText('The formula stays until you pick a field.')).toBeTruthy();
        await user.selectOptions(screen.getByTitle('Field type: unknown'), 'contains');
        expect(onChange).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: /Choose a field/ }));
        await user.click(screen.getByRole('button', { name: /^Subject/ }));
        expect(onChange).toHaveBeenCalled();
        expect(screen.queryByText('The formula stays until you pick a field.')).toBeNull();
    });

    it('"Keep the formula" goes back to the card', async () => {
        const user = userEvent.setup();
        const { onChange } = renderIn('simple', FORMULA);
        await user.click(screen.getByRole('button', { name: 'Build it again by clicking' }));
        await user.click(screen.getByRole('button', { name: 'Keep the formula' }));
        expect(screen.getByText('Custom rule')).toBeTruthy();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('moves focus with the swap: to the first row’s field, and back to "Build it again by clicking"', async () => {
        const user = userEvent.setup();
        renderIn('simple', FORMULA);
        // Opening the step moves nothing.
        expect(document.activeElement).toBe(document.body);
        await user.click(screen.getByRole('button', { name: 'Build it again by clicking' }));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Choose a field/ }));
        await user.click(screen.getByRole('button', { name: 'Keep the formula' }));
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Build it again by clicking' }));
    });

    it('offers no way into a formula from the rows', async () => {
        const user = userEvent.setup();
        renderIn('simple', 'contains(item.subject, "invoice")');
        expect(screen.queryByText('Write raw expression')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Subject/ }));
        expect(screen.getByRole('button', { name: /^From/ })).toBeTruthy();
        expect(screen.queryByText('Use an expression instead')).toBeNull();
    });
});

describe('ConditionBuilder from Advanced back to Simple (R8/R12)', () => {
    afterEach(() => cleanup());

    it('a formula the rows can show opens as rows, the same as when the step reopens', async () => {
        const user = userEvent.setup();
        const { switchTo } = renderIn('advanced', 'contains(item.frm, "fabrikam")');
        await user.click(screen.getByText('Write raw expression'));
        expect(screen.getByRole('textbox')).toBeTruthy();
        switchTo('simple');
        expect(screen.queryByText('Custom rule')).toBeNull();
        expect(screen.getByText(/There is no “frm” in the sample data/)).toBeTruthy();
        cleanup();
        // Reopened in Simple: the same row and hint.
        renderIn('simple', 'contains(item.frm, "fabrikam")');
        expect(screen.queryByText('Custom rule')).toBeNull();
        expect(screen.getByText(/There is no “frm” in the sample data/)).toBeTruthy();
    });

    it('a formula the rows cannot show still reads as the Custom rule card', async () => {
        const user = userEvent.setup();
        const { switchTo } = renderIn('advanced', FORMULA);
        expect(screen.getByRole('textbox')).toBeTruthy();
        switchTo('simple');
        expect(screen.getByText('Custom rule')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Build it again by clicking' }));
        expect(screen.queryByText('Custom rule')).toBeNull();
    });
});

describe('ConditionBuilder in Advanced mode', () => {
    afterEach(() => cleanup());

    it('keeps the formula box with the exact text', () => {
        renderIn('advanced', FORMULA);
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(FORMULA);
        expect(screen.queryByText('Custom rule')).toBeNull();
    });

    it('keeps "Write raw expression" and "Use an expression instead"', async () => {
        const user = userEvent.setup();
        renderIn('advanced', 'contains(item.subject, "invoice")');
        expect(screen.getByText('Write raw expression')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /Subject/ }));
        expect(screen.getByText('Use an expression instead')).toBeTruthy();
    });
});
