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
});
