import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CoworkStats from './CoworkStats';

/**
 * CW-11 — the figure cards.
 *
 * Two properties matter more than any exact string here:
 *
 *   1. There is no money on this block. The run path records no cost and no
 *      tokens, so a "Kosten deze maand" card could only ever show an invented
 *      amount. The test below asserts the ABSENCE of a currency, which is the
 *      only way that stays true when someone later adds a fourth card.
 *   2. A figure that is not known is never drawn as a number. "No run has
 *      finished yet" and "the average is 0m 00s" are different facts.
 */

const api = vi.hoisted(() => ({ getCoworkStats: vi.fn() }));
vi.mock('./coworkApi', () => api);

const stats = (over = {}) => ({
    total: 42,
    success: 40,
    failed: 2,
    avgDurationMs: 72_000,
    runCount: 42,
    createdAt: new Date(2026, 6, 8, 9, 0).toISOString(),
    ...over,
});

async function renderStats(over = {}) {
    api.getCoworkStats.mockResolvedValue(stats(over));
    const utils = render(<CoworkStats coworkId="w1" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId('cowork-stats').textContent).not.toContain('—'));
    return utils;
}

/** The three cards, in the order they are drawn. */
const cards = () => [...screen.getByTestId('cowork-stats').children];

beforeEach(() => { cleanup(); api.getCoworkStats.mockReset(); });

describe('CoworkStats — the three figures', () => {
    it('shows the lifetime run tally, when the work was created, and the successes', async () => {
        await renderStats();
        const [runs, succeeded, average] = cards();

        expect(runs).toHaveTextContent('42');
        expect(runs.textContent).toMatch(/since/i);
        expect(succeeded).toHaveTextContent('40');
        expect(average).toHaveTextContent('1m 12s');
        expect(average).toHaveTextContent('per run');
    });

    it('counts the failures in words under the successes, singular and plural', async () => {
        await renderStats({ failed: 2 });
        expect(cards()[1]).toHaveTextContent('2 runs failed');

        cleanup();
        await renderStats({ failed: 1 });
        expect(cards()[1]).toHaveTextContent('1 run failed');

        cleanup();
        await renderStats({ failed: 0 });
        expect(cards()[1]).toHaveTextContent('nothing went wrong');
        expect(cards()[1]).not.toHaveTextContent('failed');
    });

    it('shows the lifetime tally, NOT the number of run rows that survived retention', async () => {
        // The sweep deletes rows after 90 days; the schedule's own counter
        // does not move. "42 runs" is the true statement about the work.
        await renderStats({ runCount: 420, total: 25, success: 24, failed: 1 });
        expect(cards()[0]).toHaveTextContent('420');
        expect(cards()[0]).not.toHaveTextContent('25');
    });

    it('never puts a money figure on screen, because no cost is recorded anywhere (CW-12)', async () => {
        await renderStats();
        const block = screen.getByTestId('cowork-stats');
        expect(block.textContent).not.toMatch(/[€$£]/);
        expect(block.textContent).not.toMatch(/token/i);
        expect(block.children).toHaveLength(3);
    });
});

describe('CoworkStats — figures that are not known yet', () => {
    it('says no run has finished instead of printing an average of zero', async () => {
        api.getCoworkStats.mockResolvedValue(stats({ avgDurationMs: null, total: 1, success: 0, failed: 0 }));
        render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await waitFor(() => expect(cards()[2]).toHaveTextContent('no run has finished yet'));
        expect(cards()[2]).not.toHaveTextContent('0m 00s');
    });

    it('leaves the date line empty rather than inventing a creation date', async () => {
        await renderStats({ createdAt: null });
        expect(cards()[0].textContent).not.toMatch(/since/i);
        expect(cards()[0]).toHaveTextContent('42');
    });

    it('draws the cards with a dash while the request is still in flight', async () => {
        let resolve;
        api.getCoworkStats.mockReturnValue(new Promise((res) => { resolve = res; }));
        render(<CoworkStats coworkId="w1" reloadKey={0} />);

        // The cards exist at full height straight away, so the history below
        // them does not jump when the numbers land.
        expect(cards()).toHaveLength(3);
        for (const card of cards()) expect(card).toHaveTextContent('—');

        await act(async () => { resolve(stats()); });
        expect(cards()[0]).toHaveTextContent('42');
    });
});

describe('CoworkStats — when the figures cannot be fetched', () => {
    it('says so quietly and takes nothing else down with it', async () => {
        api.getCoworkStats.mockRejectedValue(new Error('Could not load the figures for this work'));
        render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await screen.findByTestId('cowork-stats-unavailable');

        expect(screen.queryByTestId('cowork-stats')).not.toBeInTheDocument();
        // Its own words, not the API's English error text: this line is copy.
        expect(screen.getByTestId('cowork-stats-unavailable').textContent)
            .not.toContain('Could not load the figures for this work');
    });

    it('survives a coworkApi that does not have the call at all', async () => {
        // A stale module mock, or an older bundle: the figures are optional,
        // so a missing function is a blank block and never a crashed pane.
        api.getCoworkStats = undefined;
        render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await screen.findByTestId('cowork-stats-unavailable');
        api.getCoworkStats = vi.fn();
    });
});

describe('CoworkStats — following the selection', () => {
    it('refetches for a new item and never shows the previous item’s numbers', async () => {
        api.getCoworkStats.mockResolvedValue(stats({ runCount: 42 }));
        const { rerender } = render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await waitFor(() => expect(cards()[0]).toHaveTextContent('42'));

        let resolve;
        api.getCoworkStats.mockReturnValue(new Promise((res) => { resolve = res; }));
        rerender(<CoworkStats coworkId="w2" reloadKey={0} />);
        expect(cards()[0]).not.toHaveTextContent('42');

        await act(async () => { resolve(stats({ runCount: 7 })); });
        expect(cards()[0]).toHaveTextContent('7');
        expect(api.getCoworkStats).toHaveBeenLastCalledWith('w2');
    });

    it('refetches on a reloadKey bump, so a fresh run moves the numbers', async () => {
        api.getCoworkStats.mockResolvedValue(stats({ runCount: 42 }));
        const { rerender } = render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await waitFor(() => expect(cards()[0]).toHaveTextContent('42'));

        api.getCoworkStats.mockResolvedValue(stats({ runCount: 43 }));
        rerender(<CoworkStats coworkId="w1" reloadKey={1} />);
        await waitFor(() => expect(cards()[0]).toHaveTextContent('43'));
        expect(api.getCoworkStats).toHaveBeenCalledTimes(2);
    });

    it('asks for nothing at all without an id', async () => {
        render(<CoworkStats coworkId={null} reloadKey={0} />);
        await act(async () => {});
        expect(api.getCoworkStats).not.toHaveBeenCalled();
    });
});

describe('CoworkStats — what falls outside the retention window', () => {
    // These fixtures have no average, so the shared helper's "wait until the
    // em dash is gone" never resolves: the Average card legitimately keeps it.
    // Wait on the tally card instead.
    async function renderSwept(over) {
        api.getCoworkStats.mockResolvedValue(stats(over));
        const utils = render(<CoworkStats coworkId="w1" reloadKey={0} />);
        await waitFor(() => expect(cards()[0].textContent).toContain('since'));
        return utils;
    }

    // total/success/failed count the rows the 90-day sweep has left; runCount
    // is lifetime. So a schedule that ran 42 times and last ran in spring
    // arrives as runCount 42 with everything else at zero — and "nothing went
    // wrong" would then read as an all-clear over a period we no longer have
    // any record of.

    it('does not turn a swept-clean history into an all-clear', async () => {
        await renderSwept({ total: 0, success: 0, failed: 0, avgDurationMs: null, runCount: 42 });
        const block = screen.getByTestId('cowork-stats');
        expect(block).toHaveTextContent('42');
        expect(block).not.toHaveTextContent('nothing went wrong');
        expect(block).toHaveTextContent('older runs are no longer kept');
    });

    it('still says "nothing went wrong" when the kept runs really are all fine', async () => {
        await renderStats({ total: 12, success: 12, failed: 0, runCount: 12 });
        expect(screen.getByTestId('cowork-stats')).toHaveTextContent('nothing went wrong');
    });

    it('says nothing about the window on a brand-new item', async () => {
        // Never run at all: zero everywhere, including the lifetime tally.
        // There is no history to have lost.
        await renderSwept({ total: 0, success: 0, failed: 0, avgDurationMs: null, runCount: 0 });
        const block = screen.getByTestId('cowork-stats');
        expect(block).not.toHaveTextContent('older runs are no longer kept');
        expect(block).toHaveTextContent('nothing went wrong');
    });
});
