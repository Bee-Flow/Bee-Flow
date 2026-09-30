import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import type { Inputs } from '@/features/flow-editor/schemaForm';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { useVariablePicker, VariablePickerProvider } from '../variables';
import { RowsEditor } from './RowsEditor';

jest.setTimeout(30_000);

function Harness({ initial, onValue, keepEmpty = false }: { initial: Inputs; onValue: (v: Inputs) => void; keepEmpty?: boolean }) {
    const [value, setValue] = useState<Inputs>(initial);
    return (
        <RowsEditor
            value={value}
            keepEmpty={keepEmpty}
            onChange={(next) => {
                setValue(next);
                onValue(next);
            }}
        />
    );
}

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

const literal = (value: string) => ({ kind: 'literal', value });
const values = () => screen.getAllByLabelText('Value');
/** The border of a field's box: the accent while it has focus. */
const border = (input: ReturnType<typeof screen.getByTestId>) => StyleSheet.flatten(input.parent?.props.style)?.borderColor;

describe('RowsEditor', () => {
    it('keeps a new row focused while its first letter makes it join the map', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{}} onValue={onValue} />);
        await fireEvent.press(screen.getByText('Add field'));
        const unfocused = border(values()[0] as never);
        await fireEvent(values()[0] as never, 'focus');
        const focused = border(values()[0] as never);
        expect(focused).not.toBe(unfocused);
        await fireEvent.changeText(values()[0] as never, 'a');
        expect(onValue).toHaveBeenLastCalledWith({ field: { kind: 'literal', value: 'a' } });
        // Same row, not a remounted one: it still has focus.
        expect(values()).toHaveLength(1);
        expect(border(values()[0] as never)).toBe(focused);
    });

    it('keeps a parameter row whose value is cleared to be retyped', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ subject: { kind: 'literal', value: 'Hi' } }} onValue={onValue} />);
        await fireEvent.changeText(values()[0] as never, '');
        expect(onValue).toHaveBeenLastCalledWith({ subject: { kind: 'literal', value: '' } });
        expect(screen.getByDisplayValue('subject')).toBeTruthy();
        await fireEvent.changeText(values()[0] as never, 'Hello');
        expect(onValue).toHaveBeenLastCalledWith({ subject: { kind: 'literal', value: 'Hello' } });
    });

    it('gives every new pending row its own identity after one is removed', async () => {
        await renderWithProviders(<Harness initial={{}} onValue={jest.fn()} />);
        await fireEvent.press(screen.getByText('Add field'));
        await fireEvent.press(screen.getByText('Add field'));
        await fireEvent.press(screen.getAllByLabelText(/^Remove field/)[0] as never);
        await fireEvent.press(screen.getByText('Add field'));
        expect(values()).toHaveLength(2);
    });

    it('keeps a renamed row the same row', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ a: literal('A'), b: literal('B') }} onValue={onValue} />);
        const name = screen.getByDisplayValue('a');
        await fireEvent.changeText(name, 'z');
        await fireEvent(name, 'blur');
        expect(onValue).toHaveBeenLastCalledWith({ z: literal('A'), b: literal('B') });
        expect(screen.getByDisplayValue('z')).toBe(name);
    });

    it('removes a row whose name is half-typed without renaming the row under it', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ a: literal('A'), c: literal('C'), d: literal('D') }} onValue={onValue} />);
        await fireEvent.changeText(screen.getByDisplayValue('c'), 'newname');
        await fireEvent.press(screen.getByLabelText('Remove c'));
        expect(onValue).toHaveBeenLastCalledWith({ a: literal('A'), d: literal('D') });
        // Was: d's row took over the half-typed name, and leaving it renamed d.
        expect(screen.queryByDisplayValue('newname')).toBeNull();
        await fireEvent(screen.getByDisplayValue('d'), 'blur');
        expect(onValue).toHaveBeenLastCalledWith({ a: literal('A'), d: literal('D') });
    });

    it('keeps a half-typed name with its own row when a row above it is removed', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ a: literal('A'), c: literal('C'), d: literal('D') }} onValue={onValue} />);
        const name = screen.getByDisplayValue('c');
        await fireEvent.changeText(name, 'newname');
        await fireEvent.press(screen.getByLabelText('Remove a'));
        expect(screen.getByDisplayValue('newname')).toBe(name);
        await fireEvent(name, 'blur');
        const last = onValue.mock.lastCall?.[0] as Inputs;
        expect(last).toEqual({ newname: literal('C'), d: literal('D') });
        expect(Object.keys(last)).toEqual(['newname', 'd']);
    });

    it('removes a new row whose name is half-typed without adding it to the map', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{}} onValue={onValue} />);
        await fireEvent.press(screen.getByText('Add field'));
        const name = screen.getByLabelText('Field name');
        await fireEvent.changeText(name, '');
        await fireEvent(name, 'blur');
        await fireEvent.changeText(values()[0] as never, 'x');
        await fireEvent.changeText(name, 'subject');
        await fireEvent.press(screen.getByLabelText(/^Remove/));
        expect(screen.queryByLabelText('Field name')).toBeNull();
        expect(onValue).not.toHaveBeenCalled();
    });

    it('keeps typing into the same new row after its first letter makes it join the map', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{}} onValue={onValue} />);
        await fireEvent.press(screen.getByText('Add field'));
        await fireEvent.press(screen.getByText('Add field'));
        const second = values()[1] as never;
        await fireEvent(second, 'focus');
        const focused = border(second);
        await fireEvent.changeText(second, 'a');
        await fireEvent.changeText(second, 'ab');
        // Was `{ field2: 'a', field: 'ab' }`: the second letter went into the other new row.
        expect(onValue).toHaveBeenLastCalledWith({ field2: literal('ab') });
        expect(border(second)).toBe(focused);
        expect(border(values()[1] as never)).not.toBe(focused);
    });

    it('lets go of a removed row, so a tap in the Input tab never lands in the row after it', async () => {
        const onValue = jest.fn();
        const total = { kind: 'template', value: '{{steps.a.output.total}}' };
        await renderWithProviders(
            <VariablePickerProvider groups={[]} sampleRoot={null} stepLabelById={null}>
                <InputTabProbe />
                <Harness initial={{ b: literal('Hello world'), c: total }} onValue={onValue} />
            </VariablePickerProvider>,
        );
        const first = values()[0] as never;
        await fireEvent(first, 'focus');
        await fireEvent(first, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
        await fireEvent.press(screen.getByLabelText('Remove b'));
        await fireEvent.press(screen.getByText(/^tap:/));
        expect(screen.getByText('tap:none')).toBeTruthy();
        expect(onValue).toHaveBeenLastCalledWith({ c: total });
    });
});
