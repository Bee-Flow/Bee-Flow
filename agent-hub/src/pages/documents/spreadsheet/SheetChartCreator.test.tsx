import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SheetChartCreator from './SheetChartCreator';
import type { SheetChartConfig } from './sheetCharts';

function setup() {
    const onCreate = vi.fn<(c: SheetChartConfig) => void>();
    render(<SheetChartCreator open onClose={() => undefined} onCreate={onCreate} selection="A1:C4" selectionKind="range" activeCell="A1" columns={26} />);
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
});
