import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JsonTree, { collectMatches } from './JsonTree';

const DATA = {
    alpha: { needle: 'yes', other: 1 },
    beta: { nothing: 'here' },
};

const NESTED = { level1: { level2: { level3: { leaf: 'deep' } } } };

describe('JsonTree — search', () => {
    beforeEach(() => cleanup());

    it('keeps a match and its ancestors, and drops everything else', () => {
        render(<JsonTree value={DATA} />);
        fireEvent.change(screen.getByLabelText('Search keys or values'), { target: { value: 'needle' } });
        expect(screen.getByText('alpha:')).toBeTruthy();
        expect(screen.getByText('needle:')).toBeTruthy();
        expect(screen.queryByText('beta:')).toBeNull();
        expect(screen.queryByText('other:')).toBeNull();
    });

    it('matches on values, not only on keys', () => {
        render(<JsonTree value={DATA} />);
        fireEvent.change(screen.getByLabelText('Search keys or values'), { target: { value: 'here' } });
        expect(screen.getByText('beta:')).toBeTruthy();
        expect(screen.queryByText('alpha:')).toBeNull();
    });

    it('says so when nothing matches, instead of showing a blank panel', () => {
        render(<JsonTree value={DATA} />);
        fireEvent.change(screen.getByLabelText('Search keys or values'), { target: { value: 'zzz' } });
        expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    });

    /**
     * The pre-pass is the whole point: the old `nodeMatches` re-walked the
     * entire subtree once per rendered node — O(n²), which reads as a hang the
     * moment the search box is reachable on a real payload. One walk, one Set,
     * and only the nodes on the path to a hit end up in it.
     */
    it('marks a hit, its container and the root — and nothing else', () => {
        const wide = Object.fromEntries(
            Array.from({ length: 200 }, (_, i) => [`g${i}`, Object.fromEntries(
                Array.from({ length: 20 }, (_, j) => [`k${j}`, `v${i}-${j}`]),
            )]),
        );
        const keep = collectMatches(wide, (t) => t.toLowerCase().includes('v3-7'));
        expect(keep.size).toBe(3);
    });
});

describe('JsonTree — how much starts open', () => {
    beforeEach(() => cleanup());

    it('opens two container levels by default', () => {
        render(<JsonTree value={NESTED} />);
        expect(screen.getByText('level1:')).toBeTruthy();
        expect(screen.getByText('level2:')).toBeTruthy();
        // The third level is announced but folded.
        expect(screen.queryByText('level3:')).toBeNull();
    });

    it('expand all reaches the bottom; collapse all folds the root', () => {
        render(<JsonTree value={NESTED} />);
        fireEvent.click(screen.getByLabelText('Expand all'));
        expect(screen.getByText('leaf:')).toBeTruthy();
        fireEvent.click(screen.getByLabelText('Collapse all'));
        expect(screen.queryByText('level1:')).toBeNull();
    });
});

describe('JsonTree — copy, count and cap', () => {
    beforeEach(() => cleanup());

    it('copies the whole value as formatted JSON', () => {
        const writeText = vi.fn();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(<JsonTree value={{ a: 1 }} />);
        fireEvent.click(screen.getByLabelText('Copy JSON'));
        expect(writeText).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    });

    it('counts a list in the product\'s own words', () => {
        render(<JsonTree value={{ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }} />);
        expect(screen.getByText('3 records')).toBeTruthy();
        expect(screen.queryByText('Array(3)')).toBeNull();
    });

    it('an object reports its OWN key count, never an inner list\'s', () => {
        // summariseData unwraps this envelope and would answer "3 records" for
        // a different node; the object itself has two keys.
        render(<JsonTree value={{ envelope: { total: 3, results: [{ a: 1 }, { a: 2 }, { a: 3 }] } }} />);
        expect(screen.getByText('{ 2 keys }')).toBeTruthy();
    });

    it('renders 50 children of one container, then offers the rest', () => {
        render(<JsonTree value={Array.from({ length: 500 }, (_, i) => i)} />);
        expect(screen.queryByText('499')).toBeNull();
        fireEvent.click(screen.getByText('+450 more'));
        expect(screen.getByText('499')).toBeTruthy();
        expect(screen.queryByText('+450 more')).toBeNull();
    });
});

describe('JsonTree — paths', () => {
    beforeEach(() => cleanup());

    it('hands a leaf its absolute binding path', () => {
        const onCopyPath = vi.fn();
        render(<JsonTree value={{ results: [{ subject: 'A' }] }} basePath="steps.x.output" onCopyPath={onCopyPath} />);
        // The leaf sits one level below the default depth.
        fireEvent.click(screen.getByLabelText('Expand all'));
        fireEvent.click(screen.getAllByLabelText('Copy path').at(-1));
        expect(onCopyPath).toHaveBeenCalledWith('steps.x.output.results[0].subject');
    });
});
