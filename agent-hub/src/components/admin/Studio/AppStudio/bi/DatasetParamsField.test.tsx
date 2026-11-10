import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import DatasetParamsField from './DatasetParamsField';
import type { ParamRow } from './datasetParamRows';

const fields = [
    { key: 'region', name: 'Region', type: 'text' },
    { key: 'paid', name: 'Paid', type: 'bool' },
];

function Harness({ onRows }: { onRows: (rows: ParamRow[]) => void }) {
    const [rows, setRows] = useState<ParamRow[]>([]);
    return <DatasetParamsField rows={rows} onChange={(next) => { setRows(next); onRows(next); }} fields={fields} />;
}

describe('DatasetParamsField', () => {
    it('adds a parameter row and edits it', async () => {
        const user = userEvent.setup();
        let latest: ParamRow[] = [];
        render(<Harness onRows={(r) => { latest = r; }} />);
        await user.click(screen.getByRole('button', { name: /Add a parameter/ }));
        expect(screen.getByRole('alert').textContent).toContain('A name starts with a letter');
        await user.type(screen.getByLabelText('Parameter name'), 'region');
        expect(screen.getByRole('alert').textContent).toContain('Pick the column');
        await user.selectOptions(screen.getByLabelText('Column the parameter filters'), 'paid');
        await user.selectOptions(screen.getByLabelText('Default value'), 'true');
        await user.click(screen.getByLabelText(/Without a value, show nothing/));
        expect(latest).toEqual([{ name: 'region', field: 'paid', op: 'eq', defaultValue: 'true', required: true }]);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText(/still decided by the table’s access rules/)).toBeTruthy();
    });
});
