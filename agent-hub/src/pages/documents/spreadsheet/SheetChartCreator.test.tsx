import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SheetChartCreator from './SheetChartCreator';
import type { SheetChartConfig } from './sheetCharts';

function setup(selection = 'A1:C4') {
    const onCreate = vi.fn<(c: SheetChartConfig) => void>();
    render(<SheetChartCreator open onClose={() => undefined} onCreate={onCreate} selection={selection} selectionKind="range" activeCell="A1" columns={26} />);
    return onCreate;
}

describe('SheetChartCreator', () => {
    test('offers every chart type', () => {
        setup();
        for (const label of ['Column', 'Bar', 'Stacked', 'Line', 'Area', 'Pie', 'Doughnut', 'Scatter', 'KPI']) {
            expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
    });

    test('creates the chosen type with the default size of 6 x 14 cells and the picked format', async () => {
        const user = userEvent.setup();
        const onCreate = setup();
        await user.click(screen.getByRole('button', { name: 'Doughnut' }));
        await user.selectOptions(screen.getByLabelText('Number format'), 'percent');
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'doughnut', format: 'percent', width: 672, height: 392, dataRange: 'B2:C4' }));
    });

    test('a KPI tile takes one cell and gets the tile size of 3 x 4 cells', async () => {
        const user = userEvent.setup();
        const onCreate = setup('F2:F2');
        await user.click(screen.getByRole('button', { name: 'KPI' }));
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'kpi', dataRange: 'F2:F2', width: 336, height: 112 }));
    });

    test('a KPI over a range and a scatter without x values are refused with the reason', async () => {
        const user = userEvent.setup();
        const onCreate = setup();
        await user.click(screen.getByRole('button', { name: 'KPI' }));
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(screen.getByText('A KPI takes one cell.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Scatter' }));
        await user.clear(screen.getByLabelText('Categories range (optional)'));
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(screen.getByText('A scatter chart needs the x values as categories range.')).toBeInTheDocument();
        expect(onCreate).not.toHaveBeenCalled();
    });

    test('stores the ranges and the anchor the way the grid names them', async () => {
        const user = userEvent.setup();
        const onCreate = setup();
        await user.clear(screen.getByLabelText('Anchor cell'));
        await user.type(screen.getByLabelText('Anchor cell'), ' $b$12 ');
        await user.clear(screen.getByLabelText('Data range'));
        await user.type(screen.getByLabelText('Data range'), 'b2:$c$4');
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ anchor: 'B12', dataRange: 'B2:C4' }));
    });

    test('stays open and says so when the chart cannot be saved', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onCreate = vi.fn(() => Promise.reject(Object.assign(new Error('This document changed.'), { code: 'document_conflict' })));
        render(<SheetChartCreator open onClose={onClose} onCreate={onCreate} selection="A1:C4" selectionKind="range" activeCell="A1" columns={26} />);
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the chart. Try again.');
        expect(screen.queryByText('This document changed.')).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    test('closes once the chart is saved', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<SheetChartCreator open onClose={onClose} onCreate={() => Promise.resolve()} selection="A1:C4" selectionKind="range" activeCell="A1" columns={26} />);
        await user.click(screen.getByRole('button', { name: 'Add chart' }));
        expect(onClose).toHaveBeenCalled();
    });
});
