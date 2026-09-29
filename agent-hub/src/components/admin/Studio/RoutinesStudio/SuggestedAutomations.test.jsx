import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stable mock API object (hoisted so it exists before the vi.mock factory runs).
const { api } = vi.hoisted(() => ({
    api: {
        getCatalog: vi.fn(),
        suggestAutomationsStream: vi.fn(),
        getLastScan: vi.fn(),
        recordSuggestionFeedback: vi.fn(),
    },
}));
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => api }));

// In-memory scopedStorage so we can assert the last-scan cache + dismiss
// ledger deterministically (mirrors the HistoryTab/EmptyState test pattern).
const { store } = vi.hoisted(() => ({ store: new Map() }));
vi.mock('../../../../utils/scopedStorage', () => ({
    default: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v); },
        removeItem: (k) => { store.delete(k); },
        getJSON: (k, fb = null) => {
            if (!store.has(k)) return fb;
            try { return JSON.parse(store.get(k)); } catch { return fb; }
        },
        setJSON: (k, v) => { store.set(k, JSON.stringify(v)); },
    },
}));

import SuggestedAutomations from './SuggestedAutomations.jsx';

const catalog = (apps) => ({
    apps: apps || [
        { id: 'gmail', label: 'Gmail', available: true },
        { id: 'google-sheets', label: 'Google Sheets', available: true },
        { id: 'youtrack', label: 'YouTrack', available: false },
    ],
});

// Drives the SSE callback with a scripted sequence of (event, data).
const driveScan = (events) => async (_body, onEvent) => { for (const [e, d] of events) onEvent(e, d); };

describe('SuggestedAutomations', () => {
    beforeEach(() => {
        cleanup();
        store.clear();
        api.getCatalog.mockReset();
        api.suggestAutomationsStream.mockReset();
        api.getLastScan.mockReset();
        api.recordSuggestionFeedback.mockReset();
        // No server-side last scan by default (optional endpoint).
        api.getLastScan.mockResolvedValue(null);
        api.recordSuggestionFeedback.mockResolvedValue(undefined);
    });

    it('shows only available integrations as selectable chips', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        expect(await screen.findByText('Gmail')).toBeTruthy();
        expect(screen.getByText('Google Sheets')).toBeTruthy();
        expect(screen.queryByText('YouTrack')).toBeNull(); // unavailable is filtered out
    });

    it('before any scan: a header that says what Bee reads, and one primary action', async () => {
        api.getCatalog.mockResolvedValue(catalog());
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        expect(screen.getByRole('heading', { name: 'Find repeating work' })).toBeTruthy();
        expect(screen.getByText(/nothing is built without you/)).toBeTruthy();
        const scan = await screen.findByRole('button', { name: 'Scan my recent work' });
        expect(scan.className).toContain('bg-[var(--accent-primary)]');
        expect(screen.queryByText(/Scanned/)).toBeNull();
    });

    it('while scanning shows one progress line, with the log behind "Show details"', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        let finish = () => {};
        api.suggestAutomationsStream.mockImplementation((_body, onEvent) => new Promise((resolve) => {
            onEvent('scan_step', { tool: 'gmail_search', integration: 'gmail', phase: 'start' });
            finish = () => {
                onEvent('done', { suggestions: [], summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] } });
                resolve();
            };
        }));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await user.click(await screen.findByRole('button', { name: 'Scan my recent work' }));
        expect(await screen.findByText('Reading Gmail…')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
        expect(screen.queryByTestId('scan-log')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Show details' }));
        expect(screen.getByTestId('scan-log').textContent).toMatch(/Reading Gmail/);
        await act(async () => { finish(); });
        expect(await screen.findByText('No repeating work spotted')).toBeTruthy();
        expect(screen.queryByTestId('scan-progress')).toBeNull();
    });

    it('streams a live scan log, summary, and a card per suggestion', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['phase', { phase: 'scanning' }],
            ['scan_step', { tool: 'gmail_search', integration: 'gmail', phase: 'start' }],
            ['scan_step', { tool: 'gmail_search', integration: 'gmail', phase: 'done', ok: true, piiCategories: [] }],
            ['done', {
                suggestions: [
                    { id: 's1', title: 'Invoice to sheet', description: 'd1', complexity: 'assisted', requiredIntegrations: ['gmail'] },
                    { id: 's2', title: 'Weekly digest', description: 'd2', complexity: 'quick', requiredIntegrations: ['gmail'] },
                ],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));

        // A transparency summary, with the per-source log behind "Show details"…
        expect(await screen.findByText(/Looked at Gmail/)).toBeTruthy();
        expect(screen.getByText(/no personal data found/)).toBeTruthy();
        expect(screen.queryByText(/gmail search/)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Show details' }));
        expect(screen.getByText(/gmail search/)).toBeTruthy();
        // …the "Scanned … · Scan again" line in place of the scan button…
        expect(screen.getByText(/Scanned/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
        // …and the suggestion rows.
        expect(screen.getByText('Invoice to sheet')).toBeTruthy();
        expect(screen.getByText('Weekly digest')).toBeTruthy();

        // Default selection is every available app.
        expect(api.suggestAutomationsStream).toHaveBeenCalledWith(
            expect.objectContaining({ integrationIds: expect.arrayContaining(['gmail', 'google-sheets']) }),
            expect.any(Function),
            expect.anything(),
        );
    });

    it('surfaces detected PII categories in the summary', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['scan_step', { tool: 'gmail_search', integration: 'gmail', phase: 'done', ok: true, piiCategories: ['Person', 'Email'] }],
            ['done', { suggestions: [], summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: ['Person', 'Email'] } }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        expect(await screen.findByText(/personal data found: Person, Email/)).toBeTruthy();
    });

    it('shows the empty-result copy when nothing repeatable is found', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', { suggestions: [], summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] } }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        // Why (what Bee read) and what to try.
        expect(await screen.findByText('No repeating work spotted')).toBeTruthy();
        expect(screen.getByText(/Bee read Gmail but found nothing that repeats/)).toBeTruthy();
        expect(screen.getByText(/name a focus such as invoices/)).toBeTruthy();
    });

    it('shows a calm cooldown (not a hard error) when rate-limited (429)', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(async () => {
            const err = new Error('Too many requests — limit is 10 per 60s. Retry in ~20s.');
            err.status = 429;
            err.retryAfter = 20;
            throw err;
        });
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        // Calm cooldown copy with a countdown…
        expect(await screen.findByText(/scan again in \d+s/)).toBeTruthy();
        // …and NOT the red failure state.
        expect(screen.queryByText("Couldn't generate ideas")).toBeNull();
    });

    it('prompts to connect an app when none are available', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog([{ id: 'gmail', label: 'Gmail', available: false }]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        expect(await screen.findByText(/Connect an app first/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
    });

    // ---- overhaul: rehydrate, re-scan, evidence, dismiss -------------------

    it('renders an evidence line + grounding badge when the backend provides them', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [{
                    id: 's1', title: 'Invoice to sheet', description: 'd1', complexity: 'assisted',
                    requiredIntegrations: ['gmail'], groundedIn: 'activity',
                    evidence: { summary: 'Observed 12 invoice emails this month' },
                    value: { minutesSavedPerMonth: 45 },
                }],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        expect(await screen.findByText('Invoice to sheet')).toBeTruthy();
        expect(screen.getByText('Observed 12 invoice emails this month')).toBeTruthy();
        expect(screen.getByText('Observed')).toBeTruthy();
        // The estimated time-saved value is intentionally not displayed.
        expect(screen.queryByText(/min\/mo|hr\/mo/i)).toBeNull();
    });

    it('rehydrates the last scan from storage WITHOUT firing a new stream call', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [{ id: 's1', title: 'Cached idea', description: 'd1', complexity: 'quick', requiredIntegrations: ['gmail'] }],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
                scannedAt: new Date().toISOString(),
            }],
        ]));

        // First mount: run a scan so it gets cached.
        const first = render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('Cached idea');
        expect(api.suggestAutomationsStream).toHaveBeenCalledTimes(1);
        first.unmount();
        cleanup();

        // Second mount: should paint from cache, no new stream call, with
        // "Scanned … · Scan again" instead of the scan button.
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        expect(await screen.findByText('Cached idea')).toBeTruthy();
        expect(screen.getByText(/Scanned just now/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Scan again' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
        expect(api.suggestAutomationsStream).toHaveBeenCalledTimes(1); // unchanged
    });

    it('Re-scan triggers exactly one new stream call', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [{ id: 's1', title: 'First idea', description: 'd1', complexity: 'quick', requiredIntegrations: ['gmail'] }],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
                scannedAt: new Date().toISOString(),
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('First idea');
        expect(api.suggestAutomationsStream).toHaveBeenCalledTimes(1);

        // The last-scan line surfaces "Scan again".
        await user.click(await screen.findByRole('button', { name: 'Scan again' }));
        await waitFor(() => expect(api.suggestAutomationsStream).toHaveBeenCalledTimes(2));
        // Scan again forces a cache bypass.
        expect(api.suggestAutomationsStream).toHaveBeenLastCalledWith(
            expect.objectContaining({ force: true }),
            expect.any(Function),
            expect.anything(),
        );
    });

    it('deleting a suggestion removes it from view, records feedback, and persists', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [
                    { id: 's1', title: 'Delete me', description: 'd1', complexity: 'quick', requiredIntegrations: ['gmail'] },
                    { id: 's2', title: 'Keep me', description: 'd2', complexity: 'quick', requiredIntegrations: ['gmail'] },
                ],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
                scannedAt: new Date().toISOString(),
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('Delete me');

        // Delete the first card — it should disappear (not grey out), the other stays.
        await user.click(screen.getAllByRole('button', { name: 'Dismiss suggestion' })[0]);
        await waitFor(() => expect(screen.queryByText('Delete me')).toBeNull());
        expect(screen.getByText('Keep me')).toBeTruthy();
        expect(screen.queryByText('Dismissed')).toBeNull();
        // Best-effort feedback recorded so the server strips it + suppresses it.
        expect(api.recordSuggestionFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'dismissed' }),
        );
        // Persisted to scoped storage so the delete survives a reload.
        const ledger = JSON.parse(store.get('routinesSuggestionState'));
        expect(Object.keys(ledger.dismissed).length).toBe(1);
    });

    it('records "built" feedback and calls onBuildSuggestion', async () => {
        const user = userEvent.setup();
        const onBuildSuggestion = vi.fn();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [{ id: 's1', title: 'Build me', description: 'd1', complexity: 'quick', requiredIntegrations: ['gmail'] }],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
                scannedAt: new Date().toISOString(),
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={onBuildSuggestion} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('Build me');
        await user.click(screen.getByRole('button', { name: 'Build it' }));
        expect(onBuildSuggestion).toHaveBeenCalled();
        expect(api.recordSuggestionFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'built' }),
        );
    });

    it('groups results into "From your activity" vs "Ideas" when both exist', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['done', {
                suggestions: [
                    { id: 's1', title: 'Observed one', description: 'd1', complexity: 'quick', requiredIntegrations: ['gmail'], groundedIn: 'activity' },
                    { id: 's2', title: 'Idea one', description: 'd2', complexity: 'quick', requiredIntegrations: ['gmail'], groundedIn: 'idea' },
                ],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: [] },
            }],
        ]));
        render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('Observed one');
        expect(screen.getByRole('button', { name: /From your activity\s*1/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Ideas\s*1/ })).toBeTruthy();
        // Filtering to ideas leaves only the idea.
        await user.click(screen.getByRole('button', { name: /Ideas\s*1/ }));
        expect(screen.queryByText('Observed one')).toBeNull();
        expect(screen.getByText('Idea one')).toBeTruthy();
    });

    it('never renders purple/violet/indigo in the scan UI', async () => {
        const user = userEvent.setup();
        api.getCatalog.mockResolvedValue(catalog());
        api.suggestAutomationsStream.mockImplementation(driveScan([
            ['scan_step', { tool: 'gmail_search', integration: 'gmail', phase: 'done', ok: false, reason: 'Privacy Shield' }],
            ['done', {
                suggestions: [{
                    id: 's1', title: 'Idea', description: 'd1', complexity: 'advanced', requiredIntegrations: ['gmail'],
                    groundedIn: 'activity', evidence: { summary: 'e' }, value: { minutesSavedPerMonth: 60 },
                }],
                summary: { integrations: ['gmail'], toolCalls: 1, piiCategories: ['Person'] },
            }],
        ]));
        const { container } = render(<SuggestedAutomations onBuildSuggestion={vi.fn()} onAskSuggestion={vi.fn()} />);
        await screen.findByText('Gmail');
        await user.click(screen.getByRole('button', { name: 'Scan my recent work' }));
        await screen.findByText('Idea');
        expect(container.innerHTML).not.toMatch(/purple|violet|indigo/);
    });
});
