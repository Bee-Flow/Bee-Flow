import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import MemorySection from './MemorySection';

/**
 * Settings → Memory.
 *
 * Two things are pinned here.
 *
 * 1. THE SWITCH. It is the account-wide kill switch, and it is deliberately
 *    NOT a delete — Manage, Import and Export stay reachable with memory off,
 *    so a user can turn it off and still get their data out. A future
 *    "helpful" change that disables those controls is a regression.
 *
 * 2. THE COUNT'S THREE STATES. The page used to render `memoryStats?.total || 0`
 *    with no loading or error state, so a pending fetch and a 403 both painted
 *    "Stored memories 0" plus the empty-state copy — a user with a full memory
 *    briefly looked like a new one, and a failed request was indistinguishable
 *    from a genuine zero.
 */

vi.mock('../../components/knowledge/memory/ImportMemoryModal', () => ({
    default: () => <div data-testid="import-modal" />,
}));

const STATS = {
    total: 67,
    typeDistribution: { labels: ['fact', 'person'], data: [39, 10] },
};

beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({}), text: async () => '',
    });
});
afterEach(() => { vi.restoreAllMocks(); });

const setup = (props = {}) => render(
    <MemorySection
        memoryStats={STATS}
        statsStatus="ok"
        user={{ id: 1, memoryEnabled: true }}
        onUpdateUser={vi.fn()}
        onOpenMemory={vi.fn()}
        onImported={vi.fn()}
        {...props}
    />,
);

describe('MemorySection — the master switch', () => {
    it('renders on when the user has never touched it', () => {
        // Absent means ON, matching the server default. Rendering it off would
        // tell every existing user their memory had been disabled.
        setup({ user: { id: 1 } });
        expect(screen.getByRole('button', { name: 'Use memory' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('renders off only when explicitly false', () => {
        setup({ user: { id: 1, memoryEnabled: false } });
        expect(screen.getByRole('button', { name: 'Use memory' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('POSTs the new value and lifts it to the app-level user', async () => {
        const onUpdateUser = vi.fn();
        setup({ onUpdateUser });

        fireEvent.click(screen.getByRole('button', { name: 'Use memory' }));

        expect(onUpdateUser).toHaveBeenCalledWith({ memoryEnabled: false });
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const [url, init] = global.fetch.mock.calls.at(-1);
        expect(String(url)).toContain('/ai/user-settings');
        expect(JSON.parse(init.body)).toEqual({ memoryEnabled: false });
    });

    it('rolls back and explains itself when the save fails', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const onUpdateUser = vi.fn();
        setup({ onUpdateUser });

        fireEvent.click(screen.getByRole('button', { name: 'Use memory' }));

        await waitFor(() => expect(screen.getByText(/Could not change the memory setting/)).toBeInTheDocument());
        expect(onUpdateUser).toHaveBeenNthCalledWith(1, { memoryEnabled: false });
        expect(onUpdateUser).toHaveBeenNthCalledWith(2, { memoryEnabled: true });
    });

    it('says what "off" means without hiding the stored memories', () => {
        setup({ user: { id: 1, memoryEnabled: false } });
        expect(screen.getByText(/not used in chats/)).toBeInTheDocument();
        expect(screen.getByText('67')).toBeInTheDocument();
    });

    it('keeps Manage and Import reachable with memory off', () => {
        // The switch makes memory inert; it must never become a data trap.
        setup({ user: { id: 1, memoryEnabled: false } });
        expect(screen.getByTestId('memory-manage-row')).toBeEnabled();
        expect(screen.getByTestId('memory-import-button')).toBeEnabled();
    });
});

describe('MemorySection — the count', () => {
    it('shows a placeholder while loading, never a zero', () => {
        setup({ statsStatus: 'loading', memoryStats: null });
        expect(screen.getByTestId('memory-count-loading')).toBeInTheDocument();
        expect(screen.queryByText('0')).not.toBeInTheDocument();
        expect(screen.queryByText(/No memories yet/)).not.toBeInTheDocument();
    });

    it('distinguishes a failed fetch from a genuine zero', () => {
        const onRetryStats = vi.fn();
        setup({ statsStatus: 'error', memoryStats: null, onRetryStats });

        expect(screen.getByText(/Could not load your memory statistics/)).toBeInTheDocument();
        expect(screen.queryByText(/No memories yet/)).not.toBeInTheDocument();

        fireEvent.click(screen.getByText('Retry'));
        expect(onRetryStats).toHaveBeenCalled();
    });

    it('shows the empty state only for a real zero', () => {
        setup({ statsStatus: 'ok', memoryStats: { total: 0, typeDistribution: { labels: [], data: [] } } });
        expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
    });

    it('labels the type chips through i18n rather than a hardcoded map', () => {
        setup();
        expect(screen.getByText('Facts: 39')).toBeInTheDocument();
        expect(screen.getByText('People: 10')).toBeInTheDocument();
    });
});
