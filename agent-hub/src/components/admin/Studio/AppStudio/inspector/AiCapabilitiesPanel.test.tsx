import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { AiCapabilitiesPanel } from './AiCapabilitiesPanel';
import { updateAiWebSearch } from '../state/aiWebSearchOps';
import type { AiCapabilities, AiCapabilitiesApi } from '../editor/aiCapabilitiesApi';
import type { AppDefinition } from './appDefinition';

const caps = (over: Partial<AiCapabilities> = {}): AiCapabilities => ({
    webSearch: { integrationAllowed: true, providerAvailable: true },
    browsing: { integrationAllowed: true, backendAvailable: false },
    ...over,
});
const apiOf = (value: AiCapabilities): AiCapabilitiesApi => ({ get: vi.fn(async () => value) });
const def = (extra: Record<string, unknown> = {}) => ({ actions: {}, ...extra }) as AppDefinition;

function renderPanel(definition: AppDefinition, api: AiCapabilitiesApi, appId: string | null = 'app1') {
    const onWebSearchChange = vi.fn();
    render(withQueryClient(<AiCapabilitiesPanel definition={definition} appId={appId} onWebSearchChange={onWebSearchChange} disabled={false} api={api} />));
    return { onWebSearchChange };
}

const rowOf = (label: string) => screen.getByText(label).closest('li') as HTMLElement;

describe('AiCapabilitiesPanel', () => {
    it('web search off for the app says so, and the switch commits true', async () => {
        const { onWebSearchChange } = renderPanel(def(), apiOf(caps()));
        expect(rowOf('Web search').textContent).toContain('Off for this app');
        await userEvent.setup().click(screen.getByLabelText(/Let the AI steps of this app search the web/i));
        expect(onWebSearchChange).toHaveBeenCalledWith(true);
    });

    it('with the app switch on it shows what the server answers', async () => {
        renderPanel(def({ aiWebSearch: { enabled: true }, aiBrowsing: { enabled: true } }), apiOf(caps()));
        expect(await screen.findByText('Available')).toBeTruthy();
        expect(rowOf('Web browsing').textContent).toContain('No browser on this server');
    });

    it('the workspace turning web search off wins over the provider', async () => {
        renderPanel(def({ aiWebSearch: { enabled: true } }), apiOf(caps({ webSearch: { integrationAllowed: false, providerAvailable: true } })));
        expect(await screen.findByText('Off in your workspace')).toBeTruthy();
    });

    it('lists what it cannot do', () => {
        renderPanel(def(), apiOf(caps()), null);
        expect(screen.getByRole('list', { name: 'It cannot' }).querySelectorAll('li').length).toBe(4);
    });
});

describe('updateAiWebSearch', () => {
    it('on writes { enabled: true }, off removes the key, and a no-op keeps the object', () => {
        const on = updateAiWebSearch(def(), true);
        expect(on.aiWebSearch).toEqual({ enabled: true });
        expect(updateAiWebSearch(on, true)).toBe(on);
        expect('aiWebSearch' in updateAiWebSearch(on, false)).toBe(false);
        const plain = def();
        expect(updateAiWebSearch(plain, false)).toBe(plain);
    });
});
