import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Toaster } from '../../components/shared/Toast';
import MemorySection, { type MemoryUser } from './MemorySection';

/**
 * Settings → Memory. Pinned: the switch is a PAUSE, not a delete (Manage and
 * Export stay reachable); the count has loading / error / zero states; an
 * organisation that disabled memory disables the personal controls; turning
 * the sensitive opt-in off warns that sensitive memories are deleted.
 */

vi.mock('../../components/knowledge/memory/ImportMemoryModal', () => ({
    default: () => <div data-testid="import-modal" />,
}));

const STATS = {
    total: 67,
    typeDistribution: { labels: ['fact', 'person'], data: [39, 10] },
};

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

const mockFetch = (response: unknown = ok()) => vi.spyOn(global, 'fetch').mockResolvedValue(response as Response);
afterEach(() => { vi.restoreAllMocks(); });

const setup = (props: Partial<React.ComponentProps<typeof MemorySection>> = {}, user: MemoryUser = { memoryEnabled: true }) => render(
    <>
        <MemorySection
            memoryStats={STATS}
            statsStatus="ok"
            user={user}
            onUpdateUser={vi.fn()}
            onOpenMemory={vi.fn()}
            onImported={vi.fn()}
            onRetryStats={vi.fn()}
            {...props}
        />
        <Toaster />
    </>,
);

const lastPost = (spy: ReturnType<typeof mockFetch>) => {
    const [url, init] = spy.mock.calls.at(-1) as [string, RequestInit];
    return { url: String(url), body: JSON.parse(String(init.body)) };
};

describe('MemorySection: the master switch', () => {
    it('is On when the user never touched it', () => {
        mockFetch();
        setup({}, {});
        expect(screen.getByRole('checkbox', { name: 'Use memory' })).toBeChecked();
        expect(screen.getByTestId('memory-state')).toHaveTextContent('On');
    });

    it('shows Paused (kept, not used or saved) only when explicitly false', () => {
        mockFetch();
        setup({}, { memoryEnabled: false });
        expect(screen.getByRole('checkbox', { name: 'Use memory' })).not.toBeChecked();
        expect(screen.getByTestId('memory-state')).toHaveTextContent('Paused (kept, not used or saved)');
        expect(screen.getByText('67')).toBeInTheDocument();
    });

    it('POSTs the new value and lifts it to the app-level user', async () => {
        const spy = mockFetch();
        const onUpdateUser = vi.fn();
        setup({ onUpdateUser });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Use memory' }));
        expect(onUpdateUser).toHaveBeenCalledWith({ memoryEnabled: false });
        await waitFor(() => expect(spy).toHaveBeenCalled());
        const { url, body } = lastPost(spy);
        expect(url).toContain('/ai/user-settings');
        expect(body).toEqual({ memoryEnabled: false });
    });

    it('rolls back and explains itself when the save fails', async () => {
        mockFetch({ ok: false, status: 500, json: async () => ({}) });
        const onUpdateUser = vi.fn();
        setup({ onUpdateUser });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Use memory' }));
        expect(await screen.findByText(/Could not change the memory setting/)).toBeInTheDocument();
        expect(onUpdateUser).toHaveBeenNthCalledWith(1, { memoryEnabled: false });
        expect(onUpdateUser).toHaveBeenNthCalledWith(2, { memoryEnabled: true });
    });

    it('keeps Manage and Export reachable while paused, and explains why Import is not', () => {
        mockFetch();
        setup({}, { memoryEnabled: false });
        expect(screen.getByTestId('memory-manage-row')).toBeEnabled();
        expect(screen.getByTestId('memory-export-row')).toBeEnabled();
        expect(screen.getByTestId('memory-import-button')).toBeDisabled();
        expect(screen.getByTestId('memory-import-paused')).toHaveTextContent(/not available while memory is paused/);
        expect(screen.getByText(/you can still manage or export them\./)).toBeInTheDocument();
        expect(screen.getByTestId('memory-manage-row')).toHaveAttribute('data-tour', 'memory-manage');
    });
});

describe('MemorySection: organisation has memory off', () => {
    it('explains and disables the controls, but keeps Manage and Export', () => {
        mockFetch();
        setup({}, { memoryEnabled: true, orgMemoryEnabled: false, sensitiveOptInAllowed: true });
        expect(screen.getByTestId('memory-org-off')).toHaveTextContent(/organisation has turned memory off/);
        expect(screen.getByRole('checkbox', { name: 'Use memory' })).toBeDisabled();
        expect(screen.getByRole('checkbox', { name: 'Remember sensitive topics' })).toBeDisabled();
        expect(screen.getByTestId('memory-import-button')).toBeDisabled();
        expect(screen.getByTestId('memory-manage-row')).toBeEnabled();
        expect(screen.getByTestId('memory-export-row')).toBeEnabled();
    });
});

describe('MemorySection: sensitive topics', () => {
    it('is absent unless the organisation allows it', () => {
        mockFetch();
        setup({}, { memoryEnabled: true });
        expect(screen.queryByRole('checkbox', { name: 'Remember sensitive topics' })).not.toBeInTheDocument();
    });

    it('turns on without a warning', async () => {
        const spy = mockFetch();
        setup({}, { memoryEnabled: true, sensitiveOptInAllowed: true, memorySensitiveOptIn: false });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Remember sensitive topics' }));
        await waitFor(() => expect(spy).toHaveBeenCalled());
        expect(lastPost(spy).body).toEqual({ memorySensitiveOptIn: true });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('warns before turning off, and does nothing when cancelled', async () => {
        const spy = mockFetch();
        const onUpdateUser = vi.fn();
        setup({ onUpdateUser }, { memoryEnabled: true, sensitiveOptInAllowed: true, memorySensitiveOptIn: true });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Remember sensitive topics' }));
        expect(await screen.findByRole('dialog')).toHaveTextContent(/will be deleted/);
        await userEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        expect(spy).not.toHaveBeenCalled();
        expect(onUpdateUser).not.toHaveBeenCalled();
        expect(screen.getByRole('checkbox', { name: 'Remember sensitive topics' })).toBeChecked();
    });

    it('turns off after the confirmation and refreshes the counts', async () => {
        const spy = mockFetch();
        const onRetryStats = vi.fn();
        setup({ onRetryStats }, { memoryEnabled: true, sensitiveOptInAllowed: true, memorySensitiveOptIn: true });
        await userEvent.click(screen.getByRole('checkbox', { name: 'Remember sensitive topics' }));
        await userEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(spy).toHaveBeenCalled());
        expect(lastPost(spy).body).toEqual({ memorySensitiveOptIn: false });
        await waitFor(() => expect(onRetryStats).toHaveBeenCalled());
    });
});

describe('MemorySection: counts and actions', () => {
    it('shows a placeholder while loading, never a zero', () => {
        mockFetch();
        setup({ statsStatus: 'loading', memoryStats: null });
        expect(screen.getByTestId('memory-count-loading')).toBeInTheDocument();
        expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('distinguishes a failed fetch from a genuine zero', async () => {
        mockFetch();
        const onRetryStats = vi.fn();
        setup({ statsStatus: 'error', memoryStats: null, onRetryStats });
        expect(screen.getByText(/Could not load your memory statistics/)).toBeInTheDocument();
        expect(screen.queryByText(/No memories yet/)).not.toBeInTheDocument();
        await userEvent.click(screen.getByText('Retry'));
        expect(onRetryStats).toHaveBeenCalled();
    });

    it('shows the empty state only for a real zero', () => {
        mockFetch();
        setup({ memoryStats: { total: 0, typeDistribution: { labels: [], data: [] } } });
        expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
    });

    it('labels the type chips through i18n', () => {
        mockFetch();
        setup();
        expect(screen.getByText('Facts: 39')).toBeInTheDocument();
        expect(screen.getByText('People: 10')).toBeInTheDocument();
    });

    it('shows when memory was last updated', () => {
        mockFetch();
        setup({ memoryStats: { ...STATS, lastUpdatedAt: new Date(Date.now() - 3 * 3600_000).toISOString() } });
        expect(screen.getByText('Last updated 3h ago')).toBeInTheDocument();
    });

    it('links the pending-review count into the panel review tab', async () => {
        mockFetch();
        const onOpenMemory = vi.fn();
        setup({ onOpenMemory, memoryStats: { ...STATS, pendingReview: 3 } });
        await userEvent.click(screen.getByRole('button', { name: /3 waiting for your review/ }));
        expect(onOpenMemory).toHaveBeenCalledWith('review');
        await userEvent.click(screen.getByTestId('memory-manage-row'));
        expect(onOpenMemory).toHaveBeenLastCalledWith();
    });

    it('clears only the personal memories after a confirmation', async () => {
        const spy = mockFetch();
        setup();
        await userEvent.click(screen.getByTestId('memory-clear-row'));
        expect(await screen.findByRole('dialog')).toHaveTextContent(/Project memories are not affected/);
        await userEvent.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(spy).toHaveBeenCalled());
        const [url, init] = spy.mock.calls.at(-1) as [string, RequestInit];
        expect(String(url)).toMatch(/\/agents\/memory\/clear$/);
        expect(init.method).toBe('POST');
        expect(init.body).toBeUndefined();
    });

    it('exports through GET /export/all', async () => {
        const spy = mockFetch(ok([]));
        URL.createObjectURL = vi.fn(() => 'blob:x'); // jsdom has none
        URL.revokeObjectURL = vi.fn();
        setup();
        await userEvent.click(screen.getByTestId('memory-export-row'));
        await waitFor(() => expect(String(spy.mock.calls.at(-1)?.[0])).toMatch(/\/agents\/memory\/export\/all$/));
    });

    it('opens the import dialog', async () => {
        mockFetch();
        setup();
        await userEvent.click(screen.getByTestId('memory-import-button'));
        expect(screen.getByTestId('import-modal')).toBeInTheDocument();
    });
});
