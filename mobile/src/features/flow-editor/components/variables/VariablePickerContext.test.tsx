import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';
import { Pressable, Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { BindingInput } from '../fields';
import { useVariablePicker, VariablePickerProvider } from './VariablePickerContext';

jest.setTimeout(30_000);

/** What the Input tab does: read the step editor's active field and insert into it. */
function InputTabProbe() {
    const picker = useVariablePicker();
    const [said, setSaid] = useState('');
    return (
        <Pressable
            accessibilityRole="button"
            onPress={() => {
                const field = picker.activeField();
                if (field) field.insert('trigger.output.name');
                setSaid(field ? field.label : 'none');
            }}
        >
            <Text>{`tap:${said}`}</Text>
        </Pressable>
    );
}

function Screen({ onValue }: { onValue: (v: unknown) => void }) {
    const [shown, setShown] = useState(true);
    const [value, setValue] = useState<unknown>({ kind: 'literal', value: '' });
    return (
        <VariablePickerProvider groups={[]} sampleRoot={null} stepLabelById={null}>
            <InputTabProbe />
            <Pressable accessibilityRole="button" onPress={() => setShown(false)}>
                <Text>hide</Text>
            </Pressable>
            {/* A list-scoped provider, as Edit data and Filter mount around a row's fields. */}
            <VariablePickerProvider groups={[]} sampleRoot={null} stepLabelById={null}>
                {shown ? (
                    <BindingInput
                        label="Row value"
                        value={value}
                        onChange={(v) => {
                            setValue(v);
                            onValue(v);
                        }}
                        testID="row"
                    />
                ) : null}
            </VariablePickerProvider>
        </VariablePickerProvider>
    );
}

describe('VariablePickerProvider', () => {
    it('lets the Input tab insert into a field inside a scoped provider', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Screen onValue={onValue} />);
        await fireEvent(screen.getByTestId('row-input'), 'focus');
        await fireEvent.press(screen.getByText(/^tap:/));
        expect(screen.getByText('tap:Row value')).toBeTruthy();
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'trigger.output.name' });
    });

    it('forgets a field that went away', async () => {
        await renderWithProviders(<Screen onValue={jest.fn()} />);
        await fireEvent(screen.getByTestId('row-input'), 'focus');
        await fireEvent.press(screen.getByText('hide'));
        await fireEvent.press(screen.getByText(/^tap:/));
        expect(screen.getByText('tap:none')).toBeTruthy();
    });
});
