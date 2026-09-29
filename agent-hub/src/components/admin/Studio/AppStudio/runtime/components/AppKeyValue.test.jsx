import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppKeyValue from './AppKeyValue';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * keyValue.layout/columns (spec: server/appStudio/componentSpecs.js). 'rows' is
 * the identity: label left, value right, no marker attribute. 'grid' stacks the
 * label over the value across `columns`, with a divider between columns.
 */

const REC = { client: 'Jan', company: 'Acme BV', order: 'PO-1', delivery: 'Fri' };

function node(props = {}) {
    return {
        id: 'cmp_kv',
        type: 'keyValue',
        props: {
            source: { kind: 'static', value: REC },
            fields: [{ key: 'client', label: 'Client' }, { key: 'company', label: 'Company' }],
            ...props,
        },
        style: { span: 6 },
    };
}

function renderKV(n) {
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME }}>
            <AppKeyValue node={n} />
        </RuntimeProvider>,
    );
}

describe('AppKeyValue', () => {
    it('rows (default) renders label/value pairs and no grid marker', () => {
        const { container, getByText } = renderKV(node());
        expect(getByText('Client')).toBeTruthy();
        expect(getByText('Jan')).toBeTruthy();
        expect(container.querySelector('[data-app-keyvalue-layout]')).toBeNull();
    });

    it('grid layout stacks label over value across columns with dividers', () => {
        const { container } = renderKV(node({
            layout: 'grid', columns: 2,
            fields: [
                { key: 'client', label: 'Client' },
                { key: 'company', label: 'Company' },
                { key: 'order', label: 'Order' },
            ],
        }));
        const dl = container.querySelector('[data-app-keyvalue-layout="grid"]');
        expect(dl).toBeTruthy();
        expect(dl.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');

        const cells = [...dl.children];
        expect(cells).toHaveLength(3);
        // First cell in each row has no divider; the rest do.
        expect(cells[0].style.borderLeftColor).toBe('');
        expect(cells[1].style.borderLeftColor).toBe('var(--border-default)');
        expect(cells[2].style.borderLeftColor).toBe(''); // wraps to a new row → column 0
    });

    it('clamps columns into 1..4', () => {
        const { container } = renderKV(node({ layout: 'grid', columns: 9 }));
        const dl = container.querySelector('[data-app-keyvalue-layout="grid"]');
        expect(dl.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    });

    it('renders the empty state when there is no record', () => {
        const { getByText } = renderKV(node({ source: { kind: 'static', value: null }, emptyText: 'Niets.' }));
        expect(getByText('Niets.')).toBeTruthy();
    });
});
