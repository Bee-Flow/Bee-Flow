import { describe, expect, it } from 'vitest';
import { partNames, renderScreen } from '@/test/appScreenRender';
import { gaugeFraction, gaugeThreshold } from './AppGauge';

const gauge = (props: Record<string, unknown>) => ({ id: 'cmp_gauge', type: 'gauge', visible: true, style: { span: 4 }, props: { min: 0, max: 200, ...props } });
const THRESHOLDS = [{ from: 0, tone: 'success' }, { from: 150, tone: 'danger', label: 'Too high' }, { from: 100, tone: 'warning' }];

describe('AppGauge', () => {
    it('is a labelled meter with the value, its range and the tone of the threshold it reaches', () => {
        const { getByRole, container } = renderScreen([gauge({ label: 'Load', unit: 'kW', value: { kind: 'static', value: 160 }, thresholds: THRESHOLDS })]);
        const meter = getByRole('meter', { name: 'Load' });
        expect(meter.getAttribute('aria-valuenow')).toBe('160');
        expect(meter.getAttribute('aria-valuemin')).toBe('0');
        expect(meter.getAttribute('aria-valuemax')).toBe('200');
        expect(meter.getAttribute('aria-valuetext')).toBe('160 kW, Too high');
        expect(container.querySelector('[data-app-gauge]')?.getAttribute('data-app-gauge')).toBe('danger');
        const { rendered, declared } = partNames('gauge', container);
        expect(rendered).toEqual(declared);
    });

    it('a missing value is a dash at the start of the arc', () => {
        const { getByRole, container } = renderScreen([gauge({ value: { kind: 'static', value: null } })]);
        expect(getByRole('meter').getAttribute('aria-valuetext')).toBe('—');
        expect(container.querySelector('.bfa-gauge__fill')).toBeNull();
    });

    it('clamps the arc into min..max and picks the highest threshold reached', () => {
        expect(gaugeFraction(250, 0, 200)).toBe(1);
        expect(gaugeFraction(-5, 0, 200)).toBe(0);
        expect(gaugeFraction(5, 10, 10)).toBe(0);
        expect(gaugeThreshold(120, THRESHOLDS)?.tone).toBe('warning');
        expect(gaugeThreshold(-1, THRESHOLDS)).toBeNull();
    });
});
