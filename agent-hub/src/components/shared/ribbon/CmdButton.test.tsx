import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CmdButton from './CmdButton';

describe('CmdButton — screen tip anchoring', () => {
    it('shows the tip on focus when the caller passes a CALLBACK ref (dnd-kit setNodeRef)', () => {
        // The App Studio palette forwards useDraggable's setNodeRef — a plain
        // function. The tip must anchor on CmdButton's own object ref: a
        // function has no `.current`, and anchoring on it left the tip
        // permanently invisible while `desc` had already suppressed the
        // native title.
        const setNodeRef = vi.fn();
        render(
            <CmdButton
                label="Kanban"
                desc="A board of cards grouped by status."
                tipFooter="Click to add"
                buttonRef={setNodeRef}
                onClick={() => {}}
            />,
        );

        const button = screen.getByRole('button', { name: 'Kanban' });
        expect(setNodeRef).toHaveBeenCalledWith(button);
        // desc suppresses the native title — the tip is the only explanation.
        expect(button).not.toHaveAttribute('title');

        fireEvent.focus(button);
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveTextContent('A board of cards grouped by status.');
        // CmdTip positions from the anchor's rect and only then unhides itself;
        // with no reachable anchor it stays visibility:hidden forever.
        expect(tip.style.visibility).toBe('visible');

        fireEvent.blur(button);
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('still shows the tip with an OBJECT ref, and keeps the title without a desc', () => {
        const ref = { current: null };
        const { rerender } = render(
            <CmdButton label="Table" desc="Rows and columns." buttonRef={ref} onClick={() => {}} />,
        );
        const button = screen.getByRole('button', { name: 'Table' });
        expect(ref.current).toBe(button);

        fireEvent.focus(button);
        expect(screen.getByRole('tooltip').style.visibility).toBe('visible');

        // Without a desc the native title stays — callers that never had a
        // description are untouched.
        rerender(<CmdButton label="Table" title="Table — click to add" onClick={() => {}} />);
        expect(screen.getByRole('button', { name: /Table/ })).toHaveAttribute('title', 'Table — click to add');
    });
});
