import { screen, userEvent } from '@testing-library/react-native';
import React, { useState } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { VariablePickerProvider } from '../variables';
import { BindingInput } from './BindingInput';
import { shownText } from './testing';

/**
 * A STRUCTURED value (a map of bindings, as the AI builder stores an object
 * parameter, or an object literal) is edited as its JSON text, and an edit
 * goes back into the same structure — the web's BindingField rule. It used
 * to be saved as ONE string on the first keystroke, so the tool received the
 * binding descriptors as text instead of the values. Text that is not valid
 * JSON yet is not saved, and the field says so.
 */

jest.setTimeout(30_000);

const MAP = { Datum: { kind: 'ref', path: 'steps.a.output.date' }, Bedrag: { kind: 'literal', value: 5 } };

function Harness({ initial, onValue }: { initial: unknown; onValue: (v: unknown) => void }) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <VariablePickerProvider groups={[]} sampleRoot={null} stepLabelById={new Map()}>
            <BindingInput
                label="Fields"
                value={value}
                testID="fields"
                onChange={(v) => {
                    setValue(v);
                    onValue(v);
                }}
            />
        </VariablePickerProvider>
    );
}

describe('a structured value edited as JSON', () => {
    it('keeps a map of bindings a map, with the key the author added', async () => {
        const user = userEvent.setup();
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={MAP} onValue={onValue} />);
        const input = screen.getByTestId('fields-input');
        expect(JSON.parse(shownText(input))).toEqual(MAP);
        const next = { ...MAP, Notitie: { kind: 'literal', value: 'x' } };
        await user.paste(input, `${JSON.stringify(next)} `);
        expect(onValue).toHaveBeenLastCalledWith(next);
    });

    it('saves nothing while the text is not valid JSON, and says so', async () => {
        const user = userEvent.setup();
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={MAP} onValue={onValue} />);
        const input = screen.getByTestId('fields-input');
        await user.paste(input, JSON.stringify(MAP).slice(0, -1));
        expect(onValue).not.toHaveBeenCalled();
        expect(screen.getByText(/saved as soon as it is valid JSON/)).toBeTruthy();
        await user.paste(input, JSON.stringify(MAP));
        expect(onValue).toHaveBeenLastCalledWith(MAP);
        expect(screen.queryByText(/saved as soon as it is valid JSON/)).toBeNull();
    });

    it('keeps an object literal a literal', async () => {
        const user = userEvent.setup();
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ kind: 'literal', value: { a: 1 } }} onValue={onValue} />);
        await user.paste(screen.getByTestId('fields-input'), '{"a":2}');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: { a: 2 } });
    });

    it('offers no Formula switch for it, and "Clear it" lets the structure go', async () => {
        const user = userEvent.setup();
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={MAP} onValue={onValue} />);
        expect(screen.queryByRole('tab', { name: 'Formula' })).toBeNull();
        await user.paste(screen.getByTestId('fields-input'), '{');
        await user.press(screen.getByRole('button', { name: 'Clear it' }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: '' });
        expect(screen.queryByText(/saved as soon as it is valid JSON/)).toBeNull();
        // Plain text again: typed text is a text value.
        await user.paste(screen.getByTestId('fields-input'), 'Hello');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: 'Hello' });
    });
});
