import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import useAdjustOnChange from './useAdjustOnChange';

function Draft({ value, renders }: { value: string; renders: string[] }) {
    const [draft, setDraft] = useState(value);
    useAdjustOnChange([value], () => setDraft(value));
    renders.push(draft);
    return <span data-testid="draft">{draft}</span>;
}

describe('useAdjustOnChange', () => {
    it('does nothing on mount and adopts a changed value before paint', () => {
        const renders: string[] = [];
        const { rerender } = render(<Draft value="a" renders={renders} />);
        expect(renders).toEqual(['a']);
        rerender(<Draft value="b" renders={renders} />);
        expect(screen.getByTestId('draft').textContent).toBe('b');
        // The render with the stale draft is thrown away and re-run at once.
        expect(renders.slice(1)).toEqual(['a', 'b']);
    });

    it('compares the deps element by element, so a fresh array of the same values is no change', () => {
        let calls = 0;
        function Probe({ a, b }: { a: number; b: string }) {
            useAdjustOnChange([a, b], () => { calls += 1; });
            return null;
        }
        const { rerender } = render(<Probe a={1} b="x" />);
        rerender(<Probe a={1} b="x" />);
        expect(calls).toBe(0);
        rerender(<Probe a={2} b="x" />);
        expect(calls).toBe(1);
        rerender(<Probe a={2} b="x" />);
        expect(calls).toBe(1);
    });

    it('hands the adjustment the deps as they were before the change', () => {
        const seen: unknown[] = [];
        function Probe({ mode }: { mode: string }) {
            useAdjustOnChange([mode] as const, ([previous]) => { seen.push(`${previous}->${mode}`); });
            return null;
        }
        const { rerender } = render(<Probe mode="simple" />);
        rerender(<Probe mode="all" />);
        rerender(<Probe mode="simple" />);
        expect(seen).toEqual(['simple->all', 'all->simple']);
    });

    it('keeps local edits until the value from outside changes again', async () => {
        function Field({ value }: { value: string }) {
            const [text, setText] = useState(value);
            useAdjustOnChange([value], () => setText(value));
            return <input aria-label="f" value={text} onChange={(e) => setText(e.target.value)} />;
        }
        const { rerender } = render(<Field value="one" />);
        const input = screen.getByLabelText('f') as HTMLInputElement;
        // A re-render with the same value leaves an edit alone.
        await userEvent.clear(input);
        await userEvent.type(input, 'typed');
        rerender(<Field value="one" />);
        expect(input.value).toBe('typed');
        rerender(<Field value="two" />);
        expect(input.value).toBe('two');
    });
});
