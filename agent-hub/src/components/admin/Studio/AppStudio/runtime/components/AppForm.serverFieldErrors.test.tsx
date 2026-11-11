import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import AppForm from './AppForm';
import AppInputNumber from './AppInputNumber';
import AppInputText from './AppInputText';
import { DEFAULT_RUNTIME, RuntimeProvider } from '../RuntimeContext';
import type { ActionState } from '../actionRunner/core';
import { stub } from '@/test/mocks';

/**
 * A data-model field rule the SERVER checks (field.validation) answers per field:
 * the action's state carries `fieldErrors` keyed by form field name, and the form
 * puts each sentence under its input, the way a rule it checks itself does.
 */

function Harness({ actionState }: { actionState: ActionState }) {
    const node = {
        id: 'cmp_form', type: 'form', visible: true, onSubmit: 'act_save',
        props: { name: 'order', submitLabel: 'Save' },
        style: { span: 12, gap: 3, padding: 0 },
        children: [],
    };
    const qty = { id: 'cmp_q', type: 'input_number', props: { name: 'qty', label: 'Quantity' }, style: { span: 6 } };
    const code = { id: 'cmp_c', type: 'input_text', props: { name: 'code', label: 'Code' }, style: { span: 6 } };
    return (
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', actionState }}>
            <AppForm node={node}>
                <AppInputNumber node={stub<ComponentProps<typeof AppInputNumber>['node']>(qty)} />
                <AppInputText node={stub<ComponentProps<typeof AppInputText>['node']>(code)} />
            </AppForm>
        </RuntimeProvider>
    );
}

const failed: ActionState = {
    act_save: { status: 'error', result: undefined, error: '"Quantity" must be at least 1.', fieldErrors: { qty: '"Quantity" must be at least 1.' } },
};

describe('AppForm — server field errors', () => {
    it('shows the sentence under the field it names and clears it when that field changes', async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<Harness actionState={{}} />);
        rerender(<Harness actionState={failed} />);
        const fieldError = screen.getAllByText('"Quantity" must be at least 1.');
        // Once under the input, once as the submit summary.
        expect(fieldError.length).toBe(2);
        const qty = container.querySelector('input[name="qty"]') as HTMLInputElement;
        await user.type(qty, '3');
        expect(screen.getAllByText('"Quantity" must be at least 1.').length).toBe(1);
    });

    it('an error without fieldErrors stays only the submit summary', () => {
        const { rerender } = render(<Harness actionState={{}} />);
        rerender(<Harness actionState={{ act_save: { status: 'error', result: undefined, error: 'Something else.' } }} />);
        expect(screen.getAllByText('Something else.').length).toBe(1);
    });
});
