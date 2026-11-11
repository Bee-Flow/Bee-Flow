import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppDataGrid from './AppDataGrid';
import AppTable from './AppTable';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import type { ComponentProps, ReactElement } from 'react';
import { runtimeValue } from '@/test/appRuntime';
import { stub } from '@/test/mocks';

/**
 * Rows as a records binding with `expand` delivers them (the related row under
 * `<relation>_record`, null when the viewer may not read it), in the two
 * components that show columns: a `relation` column shows the display value,
 * a `<relation>_record.<field>` column a field of the related row.
 */

function withRuntime(ui: ReactElement) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), mode: 'run' };
    return render(<RuntimeProvider value={runtimeValue(stub<Parameters<typeof runtimeValue>[0]>(value))}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { id: 'o1', amount: 10, customer: 'rec_c1', customer_record: { id: 'rec_c1', name: 'Acme', city: 'Utrecht', _label: 'Acme' } },
    { id: 'o2', amount: 20, customer: 'rec_c2', customer_record: null },
    { id: 'o3', amount: 30, customer: null, customer_record: null },
];
const COLUMNS = [
    { key: 'customer', label: 'Customer', format: 'relation' },
    { key: 'customer_record.city', label: 'City', format: 'text' },
    { key: 'amount', label: 'Amount', format: 'number' },
];
const cells = (container: HTMLElement) => [...container.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));

describe('rows with an expanded relation', () => {
    it('a table shows the display value, a field of the related row, and a gap where it is not readable', () => {
        const node = { id: 'cmp_t', type: 'table', visible: true, props: { source: { kind: 'static', value: ROWS }, columns: COLUMNS, emptyText: '', rowLimit: 25 }, style: { span: 12 } };
        const { container } = withRuntime(<AppTable node={stub<ComponentProps<typeof AppTable>['node']>(node)} />);
        expect(cells(container)).toEqual([['Acme', 'Utrecht', '10'], ['rec_c2', '—', '20'], ['—', '—', '30']]);
    });

    it('a data grid does the same', () => {
        const node = { id: 'cmp_g', type: 'data_grid', visible: true, props: { source: { kind: 'static', value: ROWS }, columns: COLUMNS, selectable: 'none', pageSize: 25, searchable: false }, style: { span: 12 } };
        const { container } = withRuntime(<AppDataGrid node={stub<ComponentProps<typeof AppDataGrid>['node']>(node)} />);
        expect(cells(container)).toEqual([['Acme', 'Utrecht', '10'], ['rec_c2', '—', '20'], ['—', '—', '30']]);
    });
});
