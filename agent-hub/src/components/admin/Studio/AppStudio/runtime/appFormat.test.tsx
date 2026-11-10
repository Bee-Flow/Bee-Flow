import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppRenderer from './AppRenderer';
import CellValue from './components/cellValue';
import AppStat from './components/AppStat';
import { makeValueFormatter } from './chartPalette';
import { timeTickFormatter } from './components/AppChart';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from './RuntimeContext';
import { stub } from '@/test/mocks';
import type { ComponentProps, ReactElement } from 'react';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * Value formatting in the runtime (appFormat.ts): without definition.format and formatOptions
 * every converted writer is the code it replaced, value for value; with them, a key changes only
 * what it names.
 */

// The formatters the runtime had before (chartPalette.ts makeValueFormatter, cellValue's date
// cases, AppStat's displayValue / delta), verbatim.
function oldValueFormatter(valueFormat?: string) {
    return (raw: unknown) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return raw == null ? '' : String(raw);
        if (valueFormat === 'percent') return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
        if (valueFormat === 'currency') return n.toLocaleString(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
        return n.toLocaleString();
    };
}

const NUMBERS: unknown[] = [0, 1, -1, 0.5, 0.05, 12.345, 1234.5, -1234.567, 1e6, 123456789.987, '42', '1234.5', 'abc'];
const DATES: unknown[] = ['2026-03-01', '2026-03-01T00:00:00Z', '2026-12-31T23:59:59.999Z', 0, 1767225600000, 'not a date'];

const at = (ui: ReactElement) => render(ui).container;

function withFormat(ui: ReactElement, appFormat: unknown) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), appFormat };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>).container;
}

describe('value formatting — the legacy path', () => {
    it('a cell without format or formatOptions writes every number as before', () => {
        for (const format of ['number', 'currency', 'percent'] as const) {
            const old = oldValueFormatter(format);
            for (const v of NUMBERS) {
                const n = Number(v);
                if (!Number.isFinite(n)) continue;
                expect(at(<CellValue value={v} format={format} />).textContent, `${format} ${String(v)}`).toBe(old(n));
                expect(withFormat(<CellValue value={v} format={format} col={{ formatOptions: {} }} />, {}).textContent).toBe(old(n));
            }
        }
    });

    it('a cell without format or formatOptions writes every date as before', () => {
        for (const v of DATES) {
            const d = new Date(v as string | number);
            if (Number.isNaN(d.getTime())) continue;
            expect(at(<CellValue value={v} format="date" />).textContent).toBe(d.toLocaleDateString());
            expect(at(<CellValue value={v} format="datetime" />).textContent).toBe(d.toLocaleString());
        }
    });

    it('the chart formatter is the old one without a format', () => {
        for (const kind of ['number', 'currency', 'percent', undefined]) {
            const old = oldValueFormatter(kind);
            const fresh = makeValueFormatter(kind);
            const withNothing = makeValueFormatter(kind, { app: null, options: undefined });
            for (const v of NUMBERS) {
                expect(fresh(v)).toBe(old(v));
                expect(withNothing(v)).toBe(old(v));
            }
        }
        const t = Date.UTC(2026, 6, 4, 9, 30);
        expect(timeTickFormatter(400 * 86400_000)(t)).toBe(new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
    });
});

describe('value formatting — format and formatOptions', () => {
    it('a grid in USD with two decimals, from definition.format through AppRenderer', () => {
        const definition = stub<AppDefinition>({
            schemaVersion: 3,
            format: { language: 'en-US', currency: 'USD', currencyDecimals: 2 },
            screens: [{
                id: 'scr_a', name: 'A', sections: [{
                    id: 'sec_a', style: {}, children: [{
                        id: 'cmp_t', type: 'table', visible: true, style: { span: 12 },
                        props: {
                            source: { kind: 'static', value: [{ amount: 1234.5, share: 0.256 }] },
                            columns: [
                                { key: 'amount', format: 'currency' },
                                { key: 'share', format: 'percent', formatOptions: { percentScale: 'fraction', decimals: 0 } },
                            ],
                        },
                    }],
                }],
            }],
        });
        const { container } = render(<AppRenderer definition={definition} screenId="scr_a" />);
        const cells = Array.from(container.querySelectorAll('td')).map((td) => td.textContent);
        expect(cells).toEqual(['$1,234.50', '26%']);
    });

    it('a column wins over the app, and a pattern writes the date', () => {
        expect(withFormat(<CellValue value={3} format="currency" col={{ formatOptions: { currency: 'USD', decimals: 2 } }} />, { language: 'en-US', currency: 'GBP' }).textContent).toBe('$3.00');
        expect(withFormat(<CellValue value="2026-03-01" format="date" col={{ formatOptions: { pattern: 'dd-MM-yyyy' } }} />, { timeZone: 'America/New_York' }).textContent).toBe('01-03-2026');
        expect(withFormat(<CellValue value={1234567} format="number" col={{ formatOptions: { compact: true } }} />, { language: 'en-US' }).textContent).toBe('1.2M');
    });

    it('a chart formats its axis with the app format and its own options', () => {
        const fmt = makeValueFormatter('currency', { app: { language: 'en-US', currency: 'USD' }, options: { decimals: 2 } });
        expect(fmt(99)).toBe('$99.00');
        expect(fmt('label')).toBe('label');
        const t = Date.UTC(2026, 6, 4, 23, 30);
        expect(timeTickFormatter(10 * 86400_000, { language: 'en-US', timeZone: 'Asia/Tokyo' })(t)).toBe('Jul 5');
    });

    it('a stat writes a numeric value and delta, and leaves text as it is', () => {
        const node = (props: Record<string, unknown>) => stub<ComponentProps<typeof AppStat>['node']>({
            id: 'cmp_s', type: 'stat', visible: true, style: { span: 3 },
            props: { label: 'Revenue', caption: null, icon: null, ...props },
        });
        const money = withFormat(<AppStat node={node({ value: { kind: 'static', value: 1234.5 }, formatOptions: { currency: 'USD', decimals: 2 }, delta: { kind: 'static', value: -2.5 }, deltaFormat: 'percent' })} />, { language: 'en-US' });
        expect(money.textContent).toContain('$1,234.50');
        expect(money.querySelector('[data-app-stat-delta]')!.textContent).toBe('2.50%');
        const plain = withFormat(<AppStat node={node({ value: { kind: 'static', value: 1234.5 } })} />, null);
        expect(plain.textContent).toContain((1234.5).toLocaleString());
        const text = withFormat(<AppStat node={node({ value: { kind: 'static', value: '€ 12k' }, formatOptions: { currency: 'USD' } })} />, null);
        expect(text.textContent).toContain('€ 12k');
    });
});
