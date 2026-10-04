/**
 * Name boxes that write only when left must also write when the editor goes
 * away with the box still focused (paging to the next step, Back) — and a
 * NumberField follows the editor's lock like every other field.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { MultilineField } from './MultilineField';
import { NumberField } from './NumberField';
import { RowsEditor } from './RowsEditor';
import { CaseNameInput } from '../editors/route/CaseNameInput';
import { CommitText } from '../editors/shared/CommitText';

jest.setTimeout(30_000);

describe('committing on unmount', () => {
    it('CommitText writes the typed name when the editor unmounts mid-edit', async () => {
        const onCommit = jest.fn();
        await renderWithProviders(<CommitText value="old" onCommit={onCommit} testID="name" />);
        await fireEvent.changeText(screen.getByDisplayValue('old'), '  billing ');
        expect(onCommit).not.toHaveBeenCalled();
        await screen.unmount();
        expect(onCommit).toHaveBeenCalledWith('billing');
    });

    it('CommitText writes nothing on unmount when nothing was typed', async () => {
        const onCommit = jest.fn();
        await renderWithProviders(<CommitText value="old" onCommit={onCommit} />);
        await screen.unmount();
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('a switch output’s name is written on unmount, but never an empty one', async () => {
        const onCommit = jest.fn();
        await renderWithProviders(<CaseNameInput name="invoices" siblingNames={['other']} onCommit={onCommit} />);
        await fireEvent.changeText(screen.getByDisplayValue('invoices'), 'billing');
        await screen.unmount();
        expect(onCommit).toHaveBeenCalledWith('billing');

        const onEmpty = jest.fn();
        await renderWithProviders(<CaseNameInput name="invoices" siblingNames={[]} onCommit={onEmpty} />);
        await fireEvent.changeText(screen.getByDisplayValue('invoices'), '');
        await screen.unmount();
        expect(onEmpty).not.toHaveBeenCalled();
    });

    it('a named value’s new name is written on unmount', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<RowsEditor value={{ subject: { kind: 'literal', value: 'Hi' } }} onChange={onChange} keepEmpty />);
        await fireEvent.changeText(screen.getByDisplayValue('subject'), 'title');
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
        expect(onChange).toHaveBeenCalledWith({ title: { kind: 'literal', value: 'Hi' } });
    });
});

describe('NumberField', () => {
    it('is read-only when disabled', async () => {
        await renderWithProviders(<NumberField label="Batch size" value={3} onChange={jest.fn()} disabled testID="n" />);
        expect(screen.getByTestId('n-input').props.editable).toBe(false);
    });

    it('is editable otherwise', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<NumberField label="Batch size" value={3} onChange={onChange} testID="n" />);
        await fireEvent.changeText(screen.getByTestId('n-input'), '7');
        expect(onChange).toHaveBeenCalledWith(7);
    });
});

describe('MultilineField', () => {
    it('is read-only while the automation is locked', async () => {
        await renderWithProviders(<MultilineField label="System prompt" value="Be brief" onChange={jest.fn()} disabled testID="m" />);
        expect(screen.getByTestId('m-input').props.editable).toBe(false);
    });
});
