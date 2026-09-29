import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import DiagramPane from './DiagramPane';
import { TRIGGERS } from './flow/stepPalette';

/**
 * The first screen of a new routine (design 1e). Its only affordance used to
 * be the sentence "pick one from the bar above" — there was no button, and
 * the prop meant to back one was declared and never called (BFSF-327). Now
 * every trigger is a card of its own, and the assistant is one click away.
 */
describe('DiagramPane — the empty canvas', () => {
    beforeEach(cleanup);

    const title = () => screen.queryByText('What does this routine start with?');

    it('offers every trigger as a card, and adds the picked one', () => {
        const onAddTrigger = vi.fn();
        render(<DiagramPane definition={null} editable onAddTrigger={onAddTrigger} />);
        expect(title()).toBeTruthy();
        const grid = screen.getByTestId('empty-trigger-grid');
        expect(grid.querySelectorAll('button').length).toBe(TRIGGERS.length);
        fireEvent.click(screen.getByRole('button', { name: /^Form/ }));
        expect(onAddTrigger).toHaveBeenCalledWith(expect.objectContaining({ kind: 'trigger', triggerKind: 'form' }));
    });

    it('falls back to the picker when only the palette handler is wired', () => {
        const onRequestOpenPalette = vi.fn();
        render(<DiagramPane definition={null} editable onRequestOpenPalette={onRequestOpenPalette} />);
        fireEvent.click(screen.getByRole('button', { name: /^Schedule/ }));
        expect(onRequestOpenPalette).toHaveBeenCalledTimes(1);
    });

    it('hands the whole routine to the assistant when the host wires it', () => {
        const onOpenAssistant = vi.fn();
        render(<DiagramPane definition={null} editable onAddTrigger={vi.fn()} onOpenAssistant={onOpenAssistant} />);
        fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
        expect(onOpenAssistant).toHaveBeenCalledTimes(1);
    });

    it('still points at the ribbon, for the people who reach there first', () => {
        render(<DiagramPane definition={null} editable onAddTrigger={vi.fn()} />);
        expect(screen.getByText(/bar above/i)).toBeTruthy();
    });

    it('renders no button on a surface that has no handler to call', () => {
        // Static thumbnails and read-only replays pass no handler; a button
        // that did nothing would be worse than none.
        render(<DiagramPane definition={null} />);
        expect(title()).toBeTruthy();
        expect(screen.queryAllByRole('button').length).toBe(0);
    });

    it('gives way to the canvas as soon as there is a trigger', () => {
        render(<DiagramPane
            definition={{ trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } }, steps: [], edges: [] }}
            editable
            onAddTrigger={vi.fn()}
        />);
        expect(title()).toBeNull();
    });
});
