import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConditionBuilderJs from './ConditionBuilder';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';

// Both are JS components: TypeScript reads every prop without a default as
// required, so the test types them loosely instead of passing dummies.
type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const ConditionBuilder = ConditionBuilderJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

/**
 * "Is about" in the condition rows: offered only where the Condition node
 * passes `topics`, disabled with a reason when the classifier is not there,
 * and a topic + sensitivity slot instead of the value box.
 */
function renderBuilder(props: Record<string, unknown>) {
    const onChange = vi.fn();
    render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <ConditionBuilder value="" onChange={onChange} context="filter" {...props} />
        </VariablePickerProvider>,
    );
    return { onChange };
}

const opOptions = () => Array.from(document.querySelectorAll('option')).map((o) => ({ value: o.value, disabled: o.disabled }));

describe('ConditionBuilder: is about', () => {
    afterEach(() => cleanup());

    it('is not offered without topics (App Studio and older servers)', () => {
        renderBuilder({ value: 'item.body == "x"' });
        expect(opOptions().some((o) => o.value === 'isAbout')).toBe(false);
    });

    it('is offered, and disabled with its reason, when the classifier is missing', () => {
        renderBuilder({ value: 'item.body == "x"', topics: { available: false, reason: 'not_configured' } });
        expect(opOptions().find((o) => o.value === 'isAbout')).toEqual({ value: 'isAbout', disabled: true });
    });

    it('a hand-written threshold stays visible as its own level', () => {
        renderBuilder({ value: 'isAbout(item.body, "spam", 0.9)', topics: { available: true } });
        expect((screen.getByRole('combobox', { name: 'How sure it must be' }) as HTMLSelectElement).value).toBe('custom');
        expect(opOptions().map((o) => o.value)).not.toContain('strict');
    });

    it('shows the topic and sensitivity for a saved rule, and the reason it cannot run', () => {
        renderBuilder({ value: 'isAbout(item.body, "a complaint", 0.15)', topics: { available: false, reason: 'not_configured' } });
        expect((screen.getByRole('textbox', { name: 'Topic' }) as HTMLInputElement).value).toBe('a complaint');
        expect((screen.getByRole('combobox', { name: 'How sure it must be' }) as HTMLSelectElement).value).toBe('loose');
        expect(screen.getByText(/No topic classifier is installed on this server/)).toBeTruthy();
    });

    it('typing a topic and loosening it writes the expression', async () => {
        const user = userEvent.setup();
        const { onChange } = renderBuilder({ value: 'isAbout(item.body, "")', topics: { available: true } });
        await user.type(screen.getByRole('textbox', { name: 'Topic' }), 'spam');
        expect(onChange).toHaveBeenLastCalledWith('isAbout(item.body, "spam")');
        await user.selectOptions(screen.getByRole('combobox', { name: 'How sure it must be' }), 'loose');
        expect(onChange).toHaveBeenLastCalledWith('isAbout(item.body, "spam", 0.15)');
        await user.selectOptions(screen.getByRole('combobox', { name: 'How sure it must be' }), 'normal');
        expect(onChange).toHaveBeenLastCalledWith('isAbout(item.body, "spam")');
        expect(screen.getByText(/Nothing leaves the server/)).toBeTruthy();
    });
});
