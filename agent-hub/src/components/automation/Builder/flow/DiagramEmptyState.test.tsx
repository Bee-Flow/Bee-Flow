import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DiagramEmptyState from './DiagramEmptyState';

/**
 * The empty canvas during a build. React Flow is not mounted before the
 * trigger exists, so this screen is the only cue for the longest silence of a
 * demo — prompt processing before the first token. Pinned: the trigger cards
 * dim and go inert, the line carries the clock and the narrated caption, and
 * the neutral text stands in when there is no narration yet.
 */
const T0 = new Date('2026-09-10T10:00:00Z').getTime();

describe('DiagramEmptyState — while the assistant is choosing a trigger', () => {
    beforeEach(() => { cleanup(); vi.useFakeTimers(); vi.setSystemTime(T0); });
    afterEach(() => { vi.useRealTimers(); });

    it('at rest: no building line, the grid is live', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} />);
        expect(screen.queryByTestId('empty-building-line')).toBeNull();
        const grid = screen.getByTestId('empty-trigger-grid');
        expect(grid.style.opacity).toBe('');
        expect(grid.getAttribute('aria-disabled')).toBeNull();
    });

    it('building: dims the trigger cards and shows the caption', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} building caption="deciding between a form and a schedule" startedAt={T0 - 4_000} />);
        const grid = screen.getByTestId('empty-trigger-grid');
        expect(grid.style.opacity).toBe('0.6');
        expect(grid.style.pointerEvents).toBe('none');
        expect(grid.getAttribute('aria-disabled')).toBe('true');
        const line = screen.getByTestId('empty-building-line');
        expect(line.textContent).toContain('Building');
        expect(screen.getByTestId('empty-building-elapsed').textContent).toContain('4s');
        expect(screen.getByTestId('empty-building-caption').textContent).toBe('deciding between a form and a schedule');
    });

    it('building without narration: the neutral "Choosing a trigger…" line', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} building />);
        expect(screen.getByTestId('empty-building-caption').textContent).toBe('Choosing a trigger…');
        // No start time → no clock, rather than a number the screen invented.
        expect(screen.queryByTestId('empty-building-elapsed')).toBeNull();
    });

    it('the clock ticks while building', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} building startedAt={T0} />);
        expect(screen.getByTestId('empty-building-elapsed').textContent).toContain('0s');
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(screen.getByTestId('empty-building-elapsed').textContent).toContain('5s');
    });

    it('a static surface (no handler) still shows the line but has no grid to dim', () => {
        render(<DiagramEmptyState building caption="reading the brief" />);
        expect(screen.getByTestId('empty-building-line').textContent).toContain('reading the brief');
        expect(screen.queryByTestId('empty-trigger-grid')).toBeNull();
    });
});

/**
 * The assistant leads (owner, 2026-11-04): the first screen asks what should
 * happen, in the person's own words, and offers three example briefs that
 * SEND. The trigger cards come second, under "or start from how it begins".
 */
describe('DiagramEmptyState — the assistant first', () => {
    beforeEach(cleanup);

    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('asks what should happen first, and puts the trigger cards second', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} onOpenAssistant={vi.fn()} onSendBrief={vi.fn()} />);
        const ask = screen.getByText('What should happen? Tell me in your own words.');
        const briefs = screen.getAllByTestId('empty-brief');
        expect(briefs).toHaveLength(3);
        const orStart = screen.getByText('or start from how it begins');
        const grid = screen.getByTestId('empty-trigger-grid');
        expect(follows(ask, briefs[0])).toBe(true);
        expect(follows(briefs[2], orStart)).toBe(true);
        expect(follows(orStart, grid)).toBe(true);
        expect(screen.queryByText('What does this automation start with?')).toBeNull();
    });

    it('an example brief is sent as it reads', async () => {
        const user = userEvent.setup();
        const onSendBrief = vi.fn();
        render(<DiagramEmptyState onAddTrigger={vi.fn()} onSendBrief={onSendBrief} />);
        const first = screen.getAllByTestId('empty-brief')[0];
        await user.click(first);
        expect(onSendBrief).toHaveBeenCalledTimes(1);
        expect(onSendBrief).toHaveBeenCalledWith(first.textContent);
        expect(String(onSendBrief.mock.calls[0][0])).toMatch(/contact form/);
    });

    it('opens the assistant for a brief of your own', async () => {
        const user = userEvent.setup();
        const onOpenAssistant = vi.fn();
        render(<DiagramEmptyState onAddTrigger={vi.fn()} onOpenAssistant={onOpenAssistant} />);
        await user.click(screen.getByRole('button', { name: 'Describe it to the assistant' }));
        expect(onOpenAssistant).toHaveBeenCalledTimes(1);
        // Without a send handler there is nothing for an example to do.
        expect(screen.queryByTestId('empty-brief')).toBeNull();
    });

    it('while the assistant builds, the examples cannot be sent twice', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} onSendBrief={vi.fn()} building />);
        for (const b of screen.getAllByTestId('empty-brief')) expect((b as HTMLButtonElement).disabled).toBe(true);
    });

    it('without an assistant it keeps the question of how the automation starts', () => {
        render(<DiagramEmptyState onAddTrigger={vi.fn()} />);
        expect(screen.getByText('What does this automation start with?')).toBeTruthy();
        expect(screen.queryByText('or start from how it begins')).toBeNull();
        expect(screen.queryByTestId('empty-brief')).toBeNull();
    });
});
