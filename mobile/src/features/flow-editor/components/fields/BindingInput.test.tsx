import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';
import { Pressable, Text } from 'react-native';

import type { VariableGroup } from '@/features/flow-editor/bindings';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { VariablePickerProvider } from '../variables';
import { BindingInput, type BindingInputProps } from './BindingInput';
import { getByShownText, shownText } from './testing';

jest.setTimeout(30_000);

const GROUPS: VariableGroup[] = [
    {
        id: 'act_1',
        label: 'gmail search',
        kind: 'step',
        basePath: 'steps.act_1.output',
        sample: { total: 2 },
        fields: [{ key: 'total', path: 'steps.act_1.output.total', sample: 2 }],
    },
];

/** A field that keeps what it sends, as the step editor does; `replacement` is a value set from elsewhere (undo, the AI builder). */
function Harness({
    initial,
    onValue,
    simple = false,
    replacement,
    ...rest
}: Omit<BindingInputProps, 'value' | 'onChange'> & { initial: unknown; onValue: (v: unknown) => void; simple?: boolean; replacement?: unknown }) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <VariablePickerProvider groups={GROUPS} sampleRoot={null} stepLabelById={new Map([['act_1', 'gmail search']])} simple={simple}>
            {replacement === undefined ? null : (
                <Pressable accessibilityRole="button" onPress={() => setValue(replacement)}>
                    <Text>replace from outside</Text>
                </Pressable>
            )}
            <BindingInput
                {...rest}
                value={value}
                onChange={(v) => {
                    setValue(v);
                    onValue(v);
                }}
            />
        </VariablePickerProvider>
    );
}

describe('BindingInput', () => {
    it('shows a stored binding with its data as a pill inside the text, never the raw path', async () => {
        await renderWithProviders(
            <Harness label="Subject" initial={{ kind: 'template', value: 'Re: {{steps.act_1.output.total}}' }} onValue={jest.fn()} testID="subject" />,
        );
        const shown = shownText(screen.getByTestId('subject-input'));
        expect(shown).toBe('Re:  gmail search ▸ Total ');
        expect(shown).not.toContain('{{');
        expect(screen.getAllByTestId('binding-pill')).toHaveLength(1);
    });

    it('sends the binding kind the typed text means', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Subject" initial={{ kind: 'literal', value: '' }} onValue={onValue} testID="subject" />);
        await fireEvent.changeText(screen.getByTestId('subject-input'), 'Hello');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: 'Hello' });
        await fireEvent.changeText(screen.getByTestId('subject-input'), 'Hello {{trigger.output.name}}');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: 'Hello {{trigger.output.name}}' });
    });

    it('inserts a picked value from the picker sheet', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Total" initial={null} onValue={onValue} testID="total" />);
        await fireEvent.press(screen.getByTestId('total-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'steps.act_1.output.total' });
        expect(shownText(screen.getByTestId('total-input'))).toBe(' gmail search ▸ Total ');
    });

    it('inserts a pick at the caret, between the words', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Subject" initial={{ kind: 'literal', value: 'Re: now' }} onValue={onValue} testID="subject" />);
        const input = screen.getByTestId('subject-input');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } });
        await fireEvent.press(screen.getByTestId('subject-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: 'Re: {{steps.act_1.output.total}}now' });
    });

    it('inserts a pick into a text replaced from elsewhere at its end, not at the caret of the text before', async () => {
        const onValue = jest.fn();
        const replacement = { kind: 'template', value: 'Re: {{steps.act_1.output.total}}' };
        await renderWithProviders(<Harness label="Subject" initial={{ kind: 'literal', value: 'Hello world' }} replacement={replacement} onValue={onValue} testID="subject" />);
        await fireEvent(screen.getByTestId('subject-input'), 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
        await fireEvent.press(screen.getByText('replace from outside'));
        await fireEvent.press(screen.getByTestId('subject-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        // Was `Re: {{{steps.act_1.output.total}}{steps.act_1.output.total}}`: the old caret split the reference.
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: 'Re: {{steps.act_1.output.total}}{{steps.act_1.output.total}}' });
    });

    it('takes a whole reference out with one backspace after its pill', async () => {
        const onValue = jest.fn();
        await renderWithProviders(
            <Harness label="Subject" initial={{ kind: 'template', value: 'Re: {{steps.act_1.output.total}}' }} onValue={onValue} testID="subject" />,
        );
        const input = screen.getByTestId('subject-input');
        const display = shownText(input).replace(/ /g, '\u00A0').replace(/^Re:\u00A0/, 'Re: ');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: display.length, end: display.length } } });
        await fireEvent.changeText(input, display.slice(0, -1));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: 'Re: ' });
        expect(screen.queryByTestId('binding-pill')).toBeNull();
    });

    it('switches to a formula and back without losing the value', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Total" initial={{ kind: 'ref', path: 'steps.act_1.output.total' }} onValue={onValue} />);
        await fireEvent.press(screen.getByRole('tab', { name: 'Formula' }));
        expect(getByShownText('gmail search ▸ Total')).toBeTruthy();
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'steps.act_1.output.total' });
        await fireEvent.press(screen.getByRole('tab', { name: 'Text' }));
        expect(getByShownText('gmail search ▸ Total')).toBeTruthy();
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'steps.act_1.output.total' });
    });

    it('keeps a real formula in formula mode, its data as pills', async () => {
        await renderWithProviders(<Harness label="Total" initial={{ kind: 'expr', value: 'steps.act_1.output.total > 1' }} onValue={jest.fn()} />);
        expect(getByShownText('gmail search ▸ Total > 1')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Text' }).props.accessibilityState).toMatchObject({ disabled: true });
    });

    it('writes a template string and a bare path in those modes', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="List" mode="path" list initial="" onValue={onValue} testID="list" />);
        expect(screen.queryByRole('tab', { name: 'Formula' })).toBeNull();
        await fireEvent.changeText(screen.getByTestId('list-input'), ' steps.act_1.output.results ');
        expect(onValue).toHaveBeenLastCalledWith('steps.act_1.output.results');
    });

    it('shows an adjusted value as its pill, the adjustment on it and in the row under it', async () => {
        const onValue = jest.fn();
        await renderWithProviders(
            <Harness label="Date" initial={{ kind: 'expr', value: 'formatDate(steps.act_1.output.total, "DD-MM-YYYY")' }} onValue={onValue} testID="date" />,
        );
        expect(shownText(screen.getByTestId('date-input'))).toBe(' gmail search ▸ Total · as a written date ');
        expect(screen.getByRole('tab', { name: 'Text' }).props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.getByText('02-09-2026')).toBeTruthy();
    });

    it('adjusts a single picked value from the row under it', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Name" initial={{ kind: 'ref', path: 'steps.act_1.output.total' }} onValue={onValue} testID="name" />);
        await fireEvent.press(screen.getByTestId('adjust-select'));
        await fireEvent.press(screen.getByText('UPPERCASE'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'expr', value: 'upper(steps.act_1.output.total)' });
        await fireEvent.press(screen.getByTestId('adjust-select'));
        await fireEvent.press(screen.getByText('use it as it is'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'steps.act_1.output.total' });
    });

    it('shows a JSON pick as its pill, not a parseJson formula, and takes it out', async () => {
        const onValue = jest.fn();
        await renderWithProviders(
            <Harness label="Name" initial={{ kind: 'expr', value: 'parseJson(steps.act_1.output.total, "customer.name")' }} onValue={onValue} testID="name" />,
        );
        expect(screen.getByText(/gmail search ▸ Total/)).toBeTruthy();
        expect(screen.getByText('· from the JSON: customer.name')).toBeTruthy();
        expect(screen.queryByText(/parseJson/)).toBeNull();
        expect(screen.getByRole('tab', { name: 'Text' }).props.accessibilityState).toMatchObject({ selected: true });
        await fireEvent.press(screen.getByTestId('name-pick-remove'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: '' });
    });

    it('opens a JSON pick as its formula on request', async () => {
        await renderWithProviders(
            <Harness label="Name" initial={{ kind: 'expr', value: 'parseJson(steps.act_1.output.total, "customer.name")' }} onValue={jest.fn()} testID="name" />,
        );
        await fireEvent.press(screen.getByRole('tab', { name: 'Formula' }));
        expect(shownText(screen.getByTestId('name-input'))).toBe('parseJson( gmail search ▸ Total , "customer.name")');
    });

    it('offers no adjustment for text with data in it', async () => {
        await renderWithProviders(<Harness label="Subject" initial={{ kind: 'template', value: 'Re: {{steps.act_1.output.total}}' }} onValue={jest.fn()} />);
        expect(screen.queryByTestId('adjust-select')).toBeNull();
    });

    it('hides the formula switch in the Simple view, unless the field holds a formula', async () => {
        await renderWithProviders(<Harness label="Total" initial={{ kind: 'literal', value: 'x' }} onValue={jest.fn()} simple />);
        expect(screen.queryByRole('tab', { name: 'Formula' })).toBeNull();
    });

    it('keeps the formula switch in the Simple view for a field that holds a formula', async () => {
        await renderWithProviders(<Harness label="Total" initial={{ kind: 'expr', value: 'steps.act_1.output.total > 1' }} onValue={jest.fn()} simple />);
        expect(screen.getByRole('tab', { name: 'Formula' })).toBeTruthy();
    });

    it('inserts a pick into a free expression at the caret, keeping what was typed', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Expression" mode="expression" initial="item.amount > 1000 && " onValue={onValue} testID="expr" />);
        expect(screen.queryByRole('tab', { name: 'Formula' })).toBeNull();
        const input = screen.getByTestId('expr-input');
        // `item.amount` shows as a pill; the caret is at the end of what is shown.
        expect(shownText(input)).toBe(' Current row ▸ Amount  > 1000 && ');
        const end = shownText(input).length;
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: end, end } } });
        await fireEvent.press(screen.getByTestId('expr-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith('item.amount > 1000 && steps.act_1.output.total');
    });

    it('replaces a single path whole with a pick', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Value" mode="path" initial="trigger.output.x" onValue={onValue} testID="p" />);
        await fireEvent.press(screen.getByTestId('p-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith('steps.act_1.output.total');
    });

    it('lets the keyboard leave machine-read text alone', async () => {
        await renderWithProviders(<Harness label="Body" mode="template" literal="code" initial="" onValue={jest.fn()} testID="body" />);
        expect(screen.getByTestId('body-input').props).toMatchObject({ autoCapitalize: 'none', autoCorrect: false, spellCheck: false });
        await renderWithProviders(<Harness label="URL" mode="template" literal="url" initial="" onValue={jest.fn()} testID="url" />);
        expect(screen.getByTestId('url-input').props).toMatchObject({ autoCapitalize: 'none', keyboardType: 'url' });
    });

    it('offers no picker outside the node editor', async () => {
        await renderWithProviders(<BindingInput label="Alone" value="" onChange={jest.fn()} testID="alone" />);
        expect(screen.queryByTestId('alone-insert')).toBeNull();
    });
});
