import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import type { ComponentProps } from 'react';
import AppForm from './AppForm';
import AppInputText from './AppInputText';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import { stub } from '@/test/mocks';

/** form.validateOn — when field errors show. Absent = on submit only. */

function Harness({ validateOn }: { validateOn?: string }) {
    const field = {
        id: 'cmp_t', type: 'input_text',
        props: { name: 'naam', label: 'Naam', required: true },
        validations: [{ type: 'minLength', value: 3 }],
        style: { span: 6 },
    };
    const node = {
        id: 'cmp_form', type: 'form', visible: true,
        props: { name: 'f', showSubmit: true, ...(validateOn ? { validateOn } : {}) },
        style: { span: 12, gap: 3, padding: 0 },
        onSubmit: 'act',
        children: [field],
    };
    const scope = buildScope(stub<Parameters<typeof buildScope>[0]>({}));
    return (
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', scope }}>
            <AppForm node={stub<ComponentProps<typeof AppForm>['node']>(node)}>
                <AppInputText node={stub<ComponentProps<typeof AppInputText>['node']>(field)} />
            </AppForm>
        </RuntimeProvider>
    );
}

describe('AppForm validateOn', () => {
    it('default: no error before submit', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const input = screen.getByRole('textbox');
        await user.click(input);
        await user.type(input, 'ab');
        await user.tab();
        expect(screen.queryByText('Enter at least 3 characters.')).toBeNull();
        await user.click(screen.getByRole('button'));
        expect(screen.getByText('Enter at least 3 characters.')).toBeTruthy();
    });

    it('blur: error shows after leaving the field, not while typing', async () => {
        const user = userEvent.setup();
        render(<Harness validateOn="blur" />);
        const input = screen.getByRole('textbox');
        await user.type(input, 'ab');
        expect(screen.queryByText('Enter at least 3 characters.')).toBeNull();
        await user.tab();
        expect(screen.getByText('Enter at least 3 characters.')).toBeTruthy();
    });

    it('change: error shows while typing and clears once valid', async () => {
        const user = userEvent.setup();
        render(<Harness validateOn="change" />);
        const input = screen.getByRole('textbox');
        await user.type(input, 'ab');
        expect(screen.getByText('Enter at least 3 characters.')).toBeTruthy();
        await user.type(input, 'c');
        expect(screen.queryByText('Enter at least 3 characters.')).toBeNull();
    });
});
