/**
 * Writing a step's output by hand without typing JSON: "Edit" on the Output
 * tab was one JSON box, so every brace, quote and comma had to be typed on a
 * phone keyboard. It is the web's field list now — named fields with a kind
 * and a value, a card per record, one box for a single value — with the JSON
 * one disclosure away, and open by itself for a shape the list cannot show.
 * Both faces edit one text, so Save checks and weighs the same thing.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/flow-editor/components/nodeEditor/OutputEditor.test.tsx
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { MAX_PINNED_BYTES } from '@/features/flow-editor/formState/outputDrafts';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { OutputEditor } from './OutputEditor';

jest.setTimeout(30_000);

async function open(value: unknown) {
    const onSave = jest.fn();
    await renderWithProviders(
        <OutputEditor seed={JSON.stringify(value, null, 2)} canRemove={false} onSave={onSave} onRemove={jest.fn()} onCancel={jest.fn()} />,
    );
    return onSave;
}

const save = () => fireEvent.press(screen.getByTestId('output-save'));
const shownJson = () => JSON.parse(screen.getByTestId('output-json').props.value as string);

describe('an object', () => {
    it('opens as named fields, with the JSON closed, and saves what was typed into them', async () => {
        const onSave = await open({ subject: 'Hello', count: 2 });
        expect(screen.queryByTestId('output-json')).toBeNull();
        expect(screen.getByTestId('output-fields-field-1-name').props.value).toBe('subject');
        expect(screen.getByText('number')).toBeTruthy();
        await fireEvent.changeText(screen.getByLabelText('subject value'), 'Hi there');
        await fireEvent.changeText(screen.getByLabelText('count value'), '3,5');
        await save();
        expect(onSave).toHaveBeenCalledWith({ subject: 'Hi there', count: 3.5 });
    });

    it('offers the number keyboard for a number and a switch for a yes/no', async () => {
        const onSave = await open({ total: 1, paid: false });
        expect(screen.getByLabelText('total value').props.keyboardType).toBe('numeric');
        await fireEvent(screen.getByLabelText('paid value'), 'valueChange', true);
        await save();
        expect(onSave).toHaveBeenCalledWith({ total: 1, paid: true });
    });

    it('changes a field’s kind from a sheet, converting its value', async () => {
        const onSave = await open({ amount: '12' });
        await fireEvent.press(screen.getByTestId('output-fields-field-1-kind'));
        await fireEvent.press(screen.getByRole('menuitem', { name: 'number' }));
        await save();
        expect(onSave).toHaveBeenCalledWith({ amount: 12 });
    });

    it('adds a field that joins the output once it has a name, and removes one', async () => {
        const onSave = await open({ a: 1, b: 2 });
        await fireEvent.press(screen.getByTestId('output-fields-add-field'));
        await fireEvent.changeText(screen.getByTestId('output-fields-field-3-name'), 'c');
        await fireEvent.changeText(screen.getByTestId('output-fields-field-3-value'), 'new');
        await fireEvent.press(screen.getByTestId('output-fields-field-1-remove'));
        await save();
        expect(onSave).toHaveBeenCalledWith({ b: 2, c: 'new' });
    });

    it('shows a nested value as what it is, without a box to flatten it in, and keeps it', async () => {
        const onSave = await open({ customer: { name: 'Ann' }, note: 'x' });
        expect(screen.getByText('group')).toBeTruthy();
        expect(screen.getByText('{ "name": "Ann" }')).toBeTruthy();
        // A kind picker for the text field only: the group's kind is a word, not a choice.
        expect(screen.getAllByRole('button', { name: /^Type: / })).toHaveLength(1);
        await fireEvent.changeText(screen.getByLabelText('note value'), 'y');
        await save();
        expect(onSave).toHaveBeenCalledWith({ customer: { name: 'Ann' }, note: 'y' });
    });
});

describe('a list of records', () => {
    it('shows a card per record, and adds one with the same fields, empty', async () => {
        const onSave = await open([{ name: 'Ann' }, { name: 'Bob' }]);
        expect(screen.getByTestId('output-record-1')).toBeTruthy();
        expect(screen.getByTestId('output-record-2')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('output-add-record'));
        await fireEvent.changeText(screen.getByTestId('output-record-3-field-1-value'), 'Cy');
        await fireEvent.press(screen.getByRole('button', { name: 'Remove #1' }));
        await save();
        expect(onSave).toHaveBeenCalledWith([{ name: 'Bob' }, { name: 'Cy' }]);
    });
});

describe('a single value', () => {
    it('is one box with no name to type, and saves as the value itself', async () => {
        const onSave = await open('<AI response>');
        expect(screen.queryByTestId('output-fields-field-1-name')).toBeNull();
        expect(screen.queryByTestId('output-fields-add-field')).toBeNull();
        // Most often an AI step's answer: a paragraph, so the Enter key makes a new line.
        expect(screen.getByLabelText('Value').props.multiline).toBe(true);
        await fireEvent.changeText(screen.getByLabelText('Value'), 'Dear Ada, thanks.');
        await save();
        expect(onSave).toHaveBeenCalledWith('Dear Ada, thanks.');
    });
});

describe('the JSON', () => {
    it('is one disclosure away and edits the same text, both ways', async () => {
        const onSave = await open({ n: 1 });
        await fireEvent.press(screen.getByTestId('output-raw-toggle'));
        await fireEvent.changeText(screen.getByLabelText('n value'), '2');
        expect(shownJson()).toEqual({ n: 2 });
        await fireEvent.changeText(screen.getByTestId('output-json'), '{"n": 2, "m": "x"}');
        expect(screen.getByLabelText('m value').props.value).toBe('x');
        await save();
        expect(onSave).toHaveBeenCalledWith({ n: 2, m: 'x' });
    });

    it('opens by itself for a shape the fields cannot show, and stays open while it is typed in', async () => {
        const onSave = await open(['a', 'b']);
        expect(screen.queryByTestId('output-raw-toggle')).toBeNull();
        expect(shownJson()).toEqual(['a', 'b']);
        await fireEvent.changeText(screen.getByTestId('output-json'), '{oops');
        await save();
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(/^Invalid JSON: /)).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('output-json'), '{"a": 1}');
        expect(screen.getByTestId('output-json')).toBeTruthy();
        expect(screen.getByLabelText('a value')).toBeTruthy();
    });

    it('still weighs what the fields wrote, and says why it refuses with the JSON closed', async () => {
        const onSave = await open({ blob: '' });
        await fireEvent.changeText(screen.getByLabelText('blob value'), 'x'.repeat(MAX_PINNED_BYTES));
        await save();
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(/^Too big to save: /)).toBeTruthy();
    });
});
