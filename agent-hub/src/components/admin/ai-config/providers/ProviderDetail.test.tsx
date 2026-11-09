import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderDetail from './ProviderDetail';
import { findProvider } from './providerRegistry';
import { withQueryClient } from '@/test/queryWrapper';

const fetchMock = vi.fn();

type Routes = Record<string, unknown>;
const stubApi = (routes: Routes) => {
    fetchMock.mockImplementation(async (url: string) => {
        const key = Object.keys(routes).find(k => String(url).includes(k));
        return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    });
};
const callsTo = (fragment: string, method: string) => fetchMock.mock.calls.filter(([url, init]) => String(url).includes(fragment) && (init?.method || 'GET') === method);

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

const renderDetail = (id: string, config: Record<string, unknown>, onMessage = vi.fn()) => {
    render(withQueryClient(<ProviderDetail entry={findProvider(id)!} config={config} allModels={[]} onMessage={onMessage} />));
    return onMessage;
};

describe('ProviderDetail', () => {
    it('saves the typed key to POST /ai/config and reports it', async () => {
        const user = userEvent.setup();
        stubApi({ '/ai/config': { hasClaudeKey: false }, '/ai/providers': { providers: [] } });
        const onMessage = renderDetail('claude', { hasClaudeKey: false });
        expect(screen.getByRole('heading', { name: 'Claude' })).toBeTruthy();
        expect(screen.getByText('Not connected')).toBeTruthy();
        const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        await user.type(screen.getByPlaceholderText('Enter your Claude API key'), 'sk-test-123');
        await user.click(save);
        await waitFor(() => expect(callsTo('/ai/config', 'POST')).toHaveLength(1));
        expect(JSON.parse(callsTo('/ai/config', 'POST')[0][1].body)).toEqual({ claudeApiKey: 'sk-test-123' });
        await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ type: 'success', text: 'Claude API key saved!' }));
    });

    it('removes a stored key after the confirm step', async () => {
        const user = userEvent.setup();
        stubApi({ '/ai/config': { hasClaudeKey: true }, '/ai/providers': { providers: [] } });
        const onMessage = renderDetail('claude', { hasClaudeKey: true });
        expect(screen.getByText('Connected')).toBeTruthy();
        await user.click(await screen.findByTitle('Delete API key'));
        expect(callsTo('/ai/config/key/', 'DELETE')).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(callsTo('/ai/config/key/claude_api_key', 'DELETE')).toHaveLength(1));
        await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ type: 'success', text: 'Claude API key removed' }));
    });

    it('sends the OpenAI EU residency switch to PUT /ai/providers/:id/region', async () => {
        const user = userEvent.setup();
        stubApi({
            '/ai/config': { hasOpenaiKey: true },
            '/region': { region: 'eu', url: 'https://eu.api.openai.com/v1' },
            '/ai/providers': { providers: [{ id: 'p-openai', type: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1' }] },
        });
        renderDetail('openai', { hasOpenaiKey: true });
        const toggle = await screen.findByRole('checkbox', { name: /Process in the EU/ });
        expect((toggle as HTMLInputElement).checked).toBe(false);
        await user.click(toggle);
        await waitFor(() => expect(callsTo('/ai/providers/p-openai/region', 'PUT')).toHaveLength(1));
        expect(JSON.parse(callsTo('/ai/providers/p-openai/region', 'PUT')[0][1].body)).toEqual({ region: 'eu' });
        await waitFor(() => expect((screen.getByRole('checkbox', { name: /Process in the EU/ }) as HTMLInputElement).checked).toBe(true));
    });
});
