import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test } from 'vitest';
import SheetChartOverlay from './SheetChartOverlay';
import { CHART_TYPES, type SheetChartConfig } from './sheetCharts';
import { evaluateSheet } from './sheetEngine';

const computed = evaluateSheet({ A1: 'M', B1: 'Sales', C1: 'Costs', A2: 'Jan', B2: '10', C2: '4', A3: 'Feb', B3: '20', C3: '6', F1: '120', F2: '100' });

function renderCharts(charts: SheetChartConfig[]) {
    const ref = createRef<HTMLElement>();
    return render(
        <div>
            <table ref={ref as React.RefObject<HTMLTableElement>}><tbody><tr><td data-cell="H2">cell</td></tr></tbody></table>
            <SheetChartOverlay contentRef={ref} charts={charts} computed={computed} readOnly={false} onRemove={() => undefined} />
        </div>,
    );
}
const one = (type: SheetChartConfig['type'], extra: Partial<SheetChartConfig> = {}): SheetChartConfig => ({
    id: type, type, title: `T-${type}`, dataRange: 'B2:C3', categoriesRange: 'A2:A3', anchor: 'H2', width: 400, height: 300, ...extra,
});

describe('SheetChartOverlay', () => {
    test('every chart type renders a card with its title at the configured size', () => {
        const charts = CHART_TYPES.filter((t) => t !== 'kpi').map((t) => one(t, t === 'scatter' ? { categoriesRange: 'B2:B3' } : {}));
        const { container } = renderCharts(charts);
        for (const c of charts) expect(screen.getByText(`T-${c.type}`)).toBeInTheDocument();
        const card = container.querySelector('[data-chart-type="hbar"]') as HTMLElement;
        expect(card.style.width).toBe('400px');
        expect(card.style.height).toBe('300px');
    });

    test('a kpi shows the formatted value and a green delta', () => {
        renderCharts([one('kpi', { dataRange: 'F1', compareRange: 'F2', label: 'Revenue', format: 'currency', title: undefined })]);
        expect(screen.getByText('Revenue')).toBeInTheDocument();
        expect(screen.getByTestId('kpi-value').textContent).toContain('120');
        expect(screen.getByTestId('kpi-delta').textContent).toBe('+20%');
        expect(screen.getByTestId('kpi-delta').className).toContain('--success');
    });

    test('a negative delta is red', () => {
        renderCharts([one('kpi', { dataRange: 'F2', compareRange: 'F1' })]);
        expect(screen.getByTestId('kpi-delta').className).toContain('--error');
    });
});
