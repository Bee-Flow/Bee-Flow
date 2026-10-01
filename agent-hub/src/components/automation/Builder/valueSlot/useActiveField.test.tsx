import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType, type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { VariablePickerProvider as ProviderJs } from '../mapping/VariablePickerContext';
import { TargetPopoverOverlay } from './TargetPopover';
import { useActiveField } from './useActiveField';
import { SlotRegistryContext } from './useSlotRegistry';
import ValueSlot from './ValueSlot';

const VariablePickerProvider = ProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

const SAMPLE = { trigger: { output: { customer: { name: 'Anna', email: 'anna@voorbeeld.nl' } } } };
const GROUPS = [{ id: 't', label: 'Bestelling ontvangen', basePath: 'trigger.output', fields: [] }];

/** The drawer in small: a "Comes in" value to click, and a step with two fields. */
function Drawer({ stepId = 'mail' }: { stepId?: string }) {
    const { registry, onFocusField, onInsert, ask, onChooseTarget, closeAsk, activeLabel } = useActiveField({ stepId, groups: GROUPS });
    const [values, setValues] = useState<Record<string, unknown>>({ cc: null, to: null });
    const slot = (id: string, label: string, required: boolean) => (
        <ValueSlot
            fieldId={id}
            label={label}
            required={required}
            value={values[id]}
            onChange={(v) => setValues(prev => ({ ...prev, [id]: v }))}
            onFocusField={onFocusField}
            schema={{ type: 'string' }}
        />
    );
    return (
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={null} stepTypeById={null}>
            <button type="button" onClick={() => onInsert('trigger.output.customer.email', { raw: false })}>E-mail in Comes in</button>
            <div className="relative"><TargetPopoverOverlay ask={ask} onChoose={onChooseTarget} onClose={closeAsk} /></div>
            <output data-testid="active">{activeLabel || ''}</output>
            <button type="button" onClick={() => onFocusField({ id: 'body', label: 'From: {{trigger.output.from}}', insert: () => {} })}>
                Focus a field named only by its example
            </button>
            <SlotRegistryContext.Provider value={registry}>
                {/* Form order: the optional field first, to show required ones are listed first. */}
                <div data-testid="cc">{slot('cc', 'Cc', false)}</div>
                <div data-testid="to">{slot('to', 'To', true)}</div>
            </SlotRegistryContext.Provider>
        </VariablePickerProvider>
    );
}

describe('useActiveField — where a clicked value goes', () => {
    beforeEach(cleanup);

    it('with no field focused it asks "Where should this go?", required fields first, and puts it there', async () => {
        render(<Drawer />);
        await userEvent.click(screen.getByRole('button', { name: 'E-mail in Comes in' }));
        const ask = screen.getByRole('dialog', { name: 'Where should this go?' });
        expect(ask.textContent).toContain('Email of customer');
        const targets = within(ask).getAllByRole('button').filter(b => b.textContent !== '').map(b => b.textContent);
        expect(targets).toEqual(['ToRequired', 'Cc']);
        await userEvent.click(within(ask).getByRole('button', { name: /^Cc/ }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(within(screen.getByTestId('cc')).getByTestId('value-chip').textContent).toContain('Email of customer');
        // The chosen field is the active one now: the next click goes there too.
        expect(screen.getByTestId('active').textContent).toBe('Cc');
    });

    it('a focused field gets the value directly', async () => {
        render(<Drawer />);
        await userEvent.click(within(screen.getByTestId('to')).getByRole('textbox'));
        await userEvent.click(screen.getByRole('button', { name: 'E-mail in Comes in' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(within(screen.getByTestId('to')).getByTestId('value-chip')).toBeTruthy();
    });

    // Confirmed bug: "BindingField's focus handle captures stale text and mode".
    // The handle the drawer keeps runs the field as it is NOW: typed text is
    // never replaced by a click that came after the typing.
    it('text typed after focusing is still there when a value arrives', async () => {
        render(<Drawer />);
        const box = within(screen.getByTestId('to')).getByRole('textbox');
        await userEvent.click(box);
        await userEvent.type(box, 'Re: ');
        await userEvent.click(screen.getByRole('button', { name: 'E-mail in Comes in' }));
        expect(within(screen.getByTestId('to')).getByDisplayValue(/Re:/)).toBeTruthy();
        expect(within(screen.getByTestId('to')).getByTestId('value-chip')).toBeTruthy();
    });

    it('a field of another step is never the target', async () => {
        const { rerender } = render(<Drawer stepId="mail" />);
        await userEvent.click(within(screen.getByTestId('to')).getByRole('textbox'));
        rerender(<Drawer stepId="next" />);
        await userEvent.click(screen.getByRole('button', { name: 'E-mail in Comes in' }));
        expect(screen.getByRole('dialog', { name: 'Where should this go?' })).toBeTruthy();
        expect(screen.getByTestId('active').textContent).toBe('');
    });

    // Final review: the "Comes in" header read "→ From: {{trigger.output.fr…".
    it('names the active field in words, never by a path', async () => {
        render(<Drawer />);
        await userEvent.click(within(screen.getByTestId('to')).getByRole('textbox'));
        expect(screen.getByTestId('active').textContent).toBe('To');
        await userEvent.click(screen.getByRole('button', { name: 'Focus a field named only by its example' }));
        expect(screen.getByTestId('active').textContent).toBe('');
    });
});
