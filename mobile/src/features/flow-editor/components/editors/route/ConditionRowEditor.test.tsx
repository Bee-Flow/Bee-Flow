import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import type { ConditionRow } from '@/features/flow-editor/model';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConditionRowEditor } from './ConditionRowEditor';

jest.setTimeout(30_000);

const OPTIONS = [{ path: 'trigger.output.subject', label: 'Subject' }];

/** A row that keeps what it sends, as ConditionBuilder does. */
function Harness({ initial, onRow }: { initial: ConditionRow; onRow: (row: ConditionRow) => void }) {
    const [row, setRow] = useState(initial);
    return (
        <ConditionRowEditor
            row={row}
            index={0}
            type="string"
            onChange={(patch) => {
                const next = { ...row, ...patch };
                setRow(next);
                onRow(next);
            }}
            onRemove={null}
            fieldOptions={OPTIONS}
            fieldBase="trigger.output"
        />
    );
}

describe('ConditionRowEditor', () => {
    it('keeps a formula field a text field while it is cleared to be retyped', async () => {
        const onRow = jest.fn();
        const initial = { field: { kind: 'expr', value: 'len(trigger.output.subject)' }, op: 'gt', value: { kind: 'literal', value: 2 } } as ConditionRow;
        await renderWithProviders(<Harness initial={initial} onRow={onRow} />);
        const input = screen.getByTestId('condition-row-1-expr-input');
        await fireEvent.changeText(input, '');
        // Was: the blank reference swapped the text field for the field picker mid-edit.
        expect(screen.queryByTestId('condition-row-1-field')).toBeNull();
        expect(screen.getByTestId('condition-row-1-expr-input')).toBe(input);
        await fireEvent.changeText(input, 'upper(trigger.output.subject)');
        expect(onRow).toHaveBeenLastCalledWith(expect.objectContaining({ field: { kind: 'expr', value: 'upper(trigger.output.subject)' } }));
    });
});

describe('ConditionRowEditor — a column of a list inside the item (R2)', () => {
    const fileRow: ConditionRow = { field: { kind: 'ref', path: 'fileType(item.attachments[*])' }, op: 'is', value: { kind: 'literal', value: '' }, quantifier: 'any' };

    function FileHarness({ onRow }: { onRow: (row: ConditionRow) => void }) {
        const [row, setRow] = useState(fileRow);
        return (
            <ConditionRowEditor
                row={row}
                index={0}
                type="fileType"
                onChange={(patch) => {
                    const next = { ...row, ...patch };
                    setRow(next);
                    onRow(next);
                }}
                onRemove={null}
                fieldOptions={[{ path: 'fileType(item.attachments[*])', label: 'File type', group: 'Attachments of each message' }]}
                fieldBase="item"
                hints={['There is no “frm” in the sample data, so this rule would match nothing.']}
            />
        );
    }

    it('asks which attachment first, offers only "is" / "is not", and takes a file type from a list', async () => {
        const onRow = jest.fn();
        await renderWithProviders(<FileHarness onRow={onRow} />);
        expect(screen.getByText('any attachment')).toBeTruthy();
        expect(screen.getByText('Choose a file type')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('condition-row-1-value-select'));
        await fireEvent.press(screen.getByTestId('condition-row-1-value-option-pdf'));
        expect(onRow).toHaveBeenLastCalledWith(expect.objectContaining({ value: { kind: 'literal', value: 'pdf' } }));
        await fireEvent.press(screen.getByTestId('condition-row-1-quantifier-select'));
        await fireEvent.press(screen.getByTestId('condition-row-1-quantifier-option-none'));
        expect(onRow).toHaveBeenLastCalledWith(expect.objectContaining({ quantifier: 'none' }));
        await fireEvent.press(screen.getByTestId('condition-row-1-op-select'));
        expect(screen.getByTestId('condition-row-1-op-option-is')).toBeTruthy();
        expect(screen.getByTestId('condition-row-1-op-option-isNot')).toBeTruthy();
        expect(screen.queryByTestId('condition-row-1-op-option-contains')).toBeNull();
        // The row's notes are shown under it.
        expect(screen.getByText('There is no “frm” in the sample data, so this rule would match nothing.')).toBeTruthy();
    });

    it('names the File type field even when the menu does not list it', async () => {
        await renderWithProviders(
            <ConditionRowEditor row={fileRow} index={0} type="fileType" onChange={jest.fn()} onRemove={null} fieldOptions={[]} fieldBase="item" />,
        );
        expect(screen.getByText('File type')).toBeTruthy();
    });
});
