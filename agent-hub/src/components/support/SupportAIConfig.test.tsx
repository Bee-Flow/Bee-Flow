import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import SupportAIConfig from './SupportAIConfig';
import SupportToolsTab from './tabs/SupportToolsTab';
import SupportInsightsTab from './tabs/SupportInsightsTab';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/support/agent')) return json({ agent: null });
        if (u.includes('/api/support/tags')) return json({ tags: [{ id: 'g1', name: 'billing', color: '#123456', organization_id: null }] });
        if (u.includes('/api/support/config')) return json({ v2Enabled: false, autoResolveThreshold: 0.5 });
        if (u.includes('/api/support/insights')) return json({ csat: { avg7d: 4.2, avg30d: null, responseRate: 0.5, responses: 8 }, handling: { aiResolved: 3, staffResolved: 4, slaBreaches: 1, total: 9, avgFirstResponseSecs: 600, avgResolutionSecs: null } });
        return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('SupportAIConfig', () => {
    it('lists its sections in a nav and opens one', async () => {
        renderWithClient(<SupportAIConfig />);
        const nav = screen.getByRole('navigation', { name: 'AI configuration' });
        expect(await screen.findByText('Bee Flow Support agent is not seeded yet. Restart the server.')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Tags' }));
        expect(nav).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tags' })).toHaveAttribute('aria-current', 'page');
        expect(await screen.findByRole('heading', { level: 2, name: 'Tag taxonomy' })).toBeInTheDocument();
        expect(await screen.findByText('#billing')).toBeInTheDocument();
    });
});

describe('SupportToolsTab', () => {
    it('switches tool use on and saves both settings', async () => {
        renderWithClient(<SupportToolsTab />);
        const toggle = await screen.findByRole('checkbox', { name: 'Enable tool-using AI (v2)' });
        await userEvent.click(toggle);
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('Saved')).toBeInTheDocument();
        const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(String(put![1].body))).toEqual({ v2Enabled: true, autoResolveThreshold: 0.5 });
    });
});

describe('SupportInsightsTab', () => {
    it('shows the figures with their labels', async () => {
        renderWithClient(<SupportInsightsTab />);
        expect(await screen.findByText('4.2/5')).toBeInTheDocument();
        expect(screen.getByText('CSAT (7d avg)')).toBeInTheDocument();
        expect(screen.getByText('8 ratings')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('of 9 threads')).toBeInTheDocument());
        expect(screen.getByText('10m')).toBeInTheDocument();
    });
});
