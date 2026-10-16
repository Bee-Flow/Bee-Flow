/**
 * Compare table on a phone: every value cell names its column (data-label), so
 * the stacked-card layout below 640 px can print "Bee Flow" / "Alternative" in
 * front of each value instead of hiding the second column behind a scroll.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CompareTable from './CompareTable';

const data = {
    enabled: true,
    leftLabel: 'Product A',
    rightLabel: 'Product B',
    rows: [{ aspect: 'Hosting', left: 'Your own cluster', right: 'Vendor cloud' }],
};

describe('compare-table mobile labels', () => {
    it('labels each value cell with its column head', () => {
        const { container } = render(<CompareTable data={data} />);
        const cells = [...container.querySelectorAll('tbody td')];
        expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(['Product A', 'Product B']);
    });

    it('falls back to the default own-product label when leftLabel is empty', () => {
        const { container } = render(<CompareTable data={{ ...data, leftLabel: '' }} />);
        expect(container.querySelector('tbody td')?.getAttribute('data-label')).toBe('Bee Flow');
    });

    it('keeps explicit table roles so the stacked layout stays a table', () => {
        render(<CompareTable data={data} />);
        // jsdom derives implicit roles; the attribute is what survives display:block.
        expect(screen.getByRole('table').getAttribute('role')).toBe('table');
        expect(screen.getAllByRole('row').every((r) => r.getAttribute('role') === 'row')).toBe(true);
        expect(screen.getAllByRole('columnheader')).toHaveLength(3);
        expect(screen.getAllByRole('rowheader')).toHaveLength(1);
        expect(screen.getAllByRole('cell')).toHaveLength(2);
        expect(screen.getAllByRole('rowgroup')).toHaveLength(2);
    });
});
