import { render, screen, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import useFitClusters from './useFitClusters';

/**
 * The convergence: collapse one candidate per layout pass until the row fits.
 * jsdom lays nothing out, so the test models the row itself — `clientWidth`
 * is the given width and `scrollWidth` is what the harness renders: one cell
 * per candidate still standing, at CELL px each.
 */
const CELL = 100;

function stubWidths(clientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() { return this.dataset.row != null ? clientWidth : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get() { return this.dataset.row != null ? this.querySelectorAll('[data-cell]').length * CELL : 0; },
    });
}
function restoreWidths() {
    delete HTMLElement.prototype.clientWidth;
    delete HTMLElement.prototype.scrollWidth;
}

function Row({ candidates, enabled = true }) {
    const ref = useRef(null);
    const collapsed = useFitClusters(ref, candidates, { enabled });
    return (
        <div ref={ref} data-row="" data-testid="row" data-collapsed={[...collapsed].join(',')}>
            {candidates.filter(c => !collapsed.has(c)).map(c => <span key={c} data-cell="">{c}</span>)}
        </div>
    );
}

const collapsedOf = () => screen.getByTestId('row').getAttribute('data-collapsed');

describe('useFitClusters', () => {
    afterEach(() => { cleanup(); restoreWidths(); vi.unstubAllGlobals(); });

    it('collapses candidates in order until the row fits, before the first paint settles', () => {
        stubWidths(2 * CELL); // room for two cells; four candidates
        render(<Row candidates={['d', 'c', 'b', 'a']} />);
        expect(collapsedOf()).toBe('d,c');
    });

    it('stops at the end of the list when nothing more can give', () => {
        stubWidths(0);
        render(<Row candidates={['b', 'a']} />);
        expect(collapsedOf()).toBe('b,a');
    });

    it('collapses nothing when the row fits — and never under jsdom\'s 0/0', () => {
        stubWidths(10 * CELL);
        render(<Row candidates={['b', 'a']} />);
        expect(collapsedOf()).toBe('');
        cleanup();
        restoreWidths();
        render(<Row candidates={['b', 'a']} />);
        expect(collapsedOf()).toBe('');
    });

    it('does nothing while disabled, and starts over when enabled', () => {
        stubWidths(CELL);
        const { rerender } = render(<Row candidates={['b', 'a']} enabled={false} />);
        expect(collapsedOf()).toBe('');
        rerender(<Row candidates={['b', 'a']} enabled />);
        expect(collapsedOf()).toBe('b');
    });

    it('a wider row starts over (a suite may unfold); a narrower one takes one more step', () => {
        let observer = null;
        vi.stubGlobal('ResizeObserver', class {
            constructor(cb) { this.cb = cb; observer = this; }
            observe() {}
            disconnect() {}
        });
        stubWidths(CELL);
        render(<Row candidates={['c', 'b', 'a']} />);
        expect(collapsedOf()).toBe('c,b');
        // Grow to three cells: everything unfolds.
        stubWidths(3 * CELL);
        act(() => observer.cb());
        expect(collapsedOf()).toBe('');
        // Shrink to two: one collapses.
        stubWidths(2 * CELL);
        act(() => observer.cb());
        expect(collapsedOf()).toBe('c');
    });
});
