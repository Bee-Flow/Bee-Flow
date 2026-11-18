// Platform services > Sanctions lists: each imported list with its status, entries and last
// error, and "Refresh now" posting the refresh.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SanctionsListsSection from './SanctionsListsSection';
import { withQueryClient } from '@/test/queryWrapper';

const STATUS = {
    refreshing: false,
    intervalHours: 24,
    pepFunctionsVersion: '2026-11-18',
    lists: [
        { id: 'eu_fsf', label: 'EU consolidated financial sanctions list', publisher: 'European Commission', infoUrl: 'https://example.test/eu', status: 'ok', entityCount: 5800, nameCount: 30000, lastAttemptAt: '2026-11-18T08:00:00.000Z', lastSuccessAt: '2026-11-18T08:00:00.000Z', replacedAt: null, lastError: null },
        { id: 'uk_fcdo', label: 'UK Sanctions List', publisher: 'FCDO', infoUrl: 'https://example.test/uk', status: 'error', entityCount: 0, nameCount: 0, lastAttemptAt: '2026-11-18T08:00:00.000Z', lastSuccessAt: null, replacedAt: null, lastError: 'the server answered HTTP 503' },
    ],
};

const calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        const body = String(url).endsWith('/refresh') ? { requested: true } : STATUS;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

describe('SanctionsListsSection', () => {
    it('shows every list with its status, entries and last error', async () => {
        render(withQueryClient(<SanctionsListsSection />));
        expect(await screen.findByText('EU consolidated financial sanctions list')).toBeTruthy();
        expect(screen.getByText('Up to date')).toBeTruthy();
        expect(screen.getByText('Last refresh failed')).toBeTruthy();
        expect(screen.getByText('Last error: the server answered HTTP 503')).toBeTruthy();
        expect(screen.getByText(/5800 entries/)).toBeTruthy();
    });

    it('"Refresh now" posts the refresh', async () => {
        render(withQueryClient(<SanctionsListsSection />));
        await userEvent.click(await screen.findByRole('button', { name: /Refresh now/ }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/admin/sanctions-lists/refresh'))).toBe(true));
    });
});
