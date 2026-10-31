// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chartsOnTab, type SheetChartConfig } from './sheetCharts';

const chart = (id: string, tab?: string): SheetChartConfig => ({ id, type: 'bar', dataRange: 'B2:B5', anchor: 'D2', width: 320, height: 220, ...(tab ? { tab } : {}) });

describe('chartsOnTab', () => {
    it('shows a chart on its own tab only; one made before tabs on every tab', () => {
        const charts = [chart('a', 't1'), chart('b', 't2'), chart('old')];
        expect(chartsOnTab(charts, 't1').map((c) => c.id)).toEqual(['a', 'old']);
        expect(chartsOnTab(charts, 't2').map((c) => c.id)).toEqual(['b', 'old']);
        expect(chartsOnTab(charts, undefined).map((c) => c.id)).toEqual(['a', 'b', 'old']);
    });
});
