import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EM_DASH, displayValue, useStickyBinding } from './uiBits';

describe('displayValue', () => {
    it('renders scalars', () => {
        expect(displayValue(null)).toBe(EM_DASH);
        expect(displayValue(undefined)).toBe(EM_DASH);
        expect(displayValue('')).toBe(EM_DASH);
        expect(displayValue('hi')).toBe('hi');
        expect(displayValue(true)).toBe('Yes');
        expect(displayValue(false)).toBe('No');
        expect(displayValue(1234)).toBe((1234).toLocaleString());
        expect(displayValue(0)).toBe('0');
    });

    it('never paints raw JSON for a dataset/records value', () => {
        const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
        expect(displayValue(rows)).toBe('3 items');
        expect(displayValue([])).toBe(EM_DASH);
        expect(displayValue({ name: 'Hive 4', id: 'rec_1' })).toBe('Hive 4');
        expect(displayValue({ label: 'Open' })).toBe('Open');
        expect(displayValue({ a: 1, b: 2 })).toBe('2 fields');
        expect(displayValue({})).toBe(EM_DASH);
        for (const value of [rows, { a: 1, b: 2 }, [{ a: 1 }, { a: 2 }]]) {
            expect(displayValue(value)).not.toContain('{');
        }
    });

    it('unwraps a single scalar row but never recurses into a container', () => {
        expect(displayValue(['only'])).toBe('only');
        expect(displayValue([{ name: 'x' }])).toBe('1 item');
        const cyclic = [];
        cyclic.push(cyclic);
        expect(displayValue(cyclic)).toBe('1 item');
    });

    it('formats a Date rather than stringifying it', () => {
        const d = new Date(2026, 2, 3);
        expect(displayValue(d)).toBe(d.toLocaleDateString());
        expect(displayValue(new Date('nope'))).toBe(EM_DASH);
    });
});

describe('useStickyBinding', () => {
    function Probe({ binding }) {
        const { value, isLoading } = useStickyBinding(binding);
        return <span data-testid="out">{isLoading ? 'loading' : JSON.stringify(value ?? null)}</span>;
    }

    it('keeps the previous value on screen while the binding refetches', () => {
        const { getByTestId, rerender } = render(<Probe binding={{ value: undefined, isLoading: true }} />);
        expect(getByTestId('out').textContent).toBe('loading');
        rerender(<Probe binding={{ value: [1, 2], isLoading: false }} />);
        expect(getByTestId('out').textContent).toBe('[1,2]');
        rerender(<Probe binding={{ value: undefined, isLoading: true }} />);
        expect(getByTestId('out').textContent).toBe('[1,2]');
        rerender(<Probe binding={{ value: [3], isLoading: false }} />);
        expect(getByTestId('out').textContent).toBe('[3]');
    });

    it('lets go once the binding genuinely resolves to nothing', () => {
        const { getByTestId, rerender } = render(<Probe binding={{ value: [1], isLoading: false }} />);
        rerender(<Probe binding={{ value: undefined, isLoading: false }} />);
        expect(getByTestId('out').textContent).toBe('null');
    });

    /**
     * The sticky memory lives in a REF, not in state written during render.
     * These two values defeat a `last !== value` guard forever, and the old
     * render-phase setState turned that into "Too many re-renders" (React #301)
     * — the whole screen of formula stats going down at once. See
     * AppRenderer.formulaBinding.test.jsx for the app-level story.
     */
    it('does not loop on NaN (NaN !== NaN is always true)', () => {
        expect(() => render(<Probe binding={{ value: NaN, isLoading: false }} />)).not.toThrow();
    });

    it('does not loop on a value that is freshly allocated every render', () => {
        // split()/concat()/parseJson() all hand back a new reference each call.
        function Churn() {
            const { value } = useStickyBinding({ value: ['a', 'b'], isLoading: false });
            return <span data-testid="churn">{value.join('')}</span>;
        }
        const { getByTestId, rerender } = render(<Churn />);
        expect(getByTestId('churn').textContent).toBe('ab');
        rerender(<Churn />);
        expect(getByTestId('churn').textContent).toBe('ab');
    });

    it('still holds a NaN through a refetch rather than blanking', () => {
        const { getByTestId, rerender } = render(<Probe binding={{ value: NaN, isLoading: false }} />);
        expect(getByTestId('out').textContent).toBe('null'); // JSON.stringify(NaN)
        rerender(<Probe binding={{ value: undefined, isLoading: true }} />);
        expect(getByTestId('out').textContent).not.toBe('loading');
    });
});
