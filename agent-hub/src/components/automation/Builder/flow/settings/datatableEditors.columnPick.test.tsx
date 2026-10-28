import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import DatatableFields from './datatableEditors';

const CATALOG = {
    datatables: [{
        id: 'tbl1', name: 'Contacts', canWrite: true,
        columns: [
            { key: 'email', name: 'E-mail address', type: 'text' },
            { key: 'age', name: 'Age', type: 'number' },
        ],
    }],
    datatableOps: [],
};

describe('datatable column suggestions', () => {
    beforeEach(cleanup);

    it('lists the column keys and writes the picked key, not undefined', () => {
        const set = vi.fn();
        render(
            <VariablePickerProvider groups={[]} previewSample={{}} stepLabelById={new Map()}>
                <DatatableFields
                    draft={{ op: 'update_rows', datatableId: 'tbl1', where: [{ field: '', op: 'eq', value: '' }] }}
                    set={set}
                    groups={[]}
                    catalog={CATALOG}
                />
            </VariablePickerProvider>,
        );
        const box = screen.getByPlaceholderText('column');
        fireEvent.focus(box);
        const option = screen.getByRole('button', { name: /^email\s*E-mail address/ });
        fireEvent.mouseDown(option);
        expect(set).toHaveBeenCalledWith('where', [{ field: 'email', op: 'eq', value: '' }]);
    });
});
