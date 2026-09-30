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
