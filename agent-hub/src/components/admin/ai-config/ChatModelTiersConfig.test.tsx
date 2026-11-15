import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each picker is a button that picks the model its row offers next.
vi.mock('../shared/SearchableModelSelect', () => ({
    default: ({ label, onChange }: { label?: string; onChange: (pick: { modelId: string; providerId: string }) => void }) => (
        <button type="button" data-testid="picker" onClick={() => onChange({ modelId: 'qwen3:8b', providerId: 'p1' })}>{label}</button>
    ),
}));

import ChatModelTiersConfig from './ChatModelTiersConfig';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
});

const MISTRAL = { id: 'mistral-large-latest', providerName: 'Mistral', providerType: 'mistral' };
const LOCAL = { id: 'qwen3:8b', providerName: 'Ollama', providerType: 'ollama', local: true };

/** The POST requests, as `path → body`. */
const posts = () => fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => [String(url).replace(/^.*\/ai\/config\//, ''), JSON.parse(String((init as RequestInit).body))]);

describe('ChatModelTiersConfig: the Claude models block', () => {
    it('is hidden when no configured chat model is a Claude model', async () => {
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        expect(await screen.findByText('Background models')).toBeTruthy();
        expect(screen.queryByText('Claude models')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Apply all recommended' })).toBeNull();
        expect(screen.queryByText('Reliability')).toBeNull();
    });

    it('is shown once one Claude model is configured, also when it comes through another provider', async () => {
        render(<ChatModelTiersConfig allModels={[MISTRAL, { id: 'claude-sonnet-4-6@20250929', providerName: 'Vertex', providerType: 'vertex' }]} />);
        expect(await screen.findByText('Claude models')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Apply all recommended' })).toBeTruthy();
        expect(screen.getByText('Reliability')).toBeTruthy();
    });
});

describe('ChatModelTiersConfig: one draft, one save bar', () => {
    it('keeps the order tiers, EU tiers, custom tiers, background models', async () => {
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        await screen.findByText('Background models');
        const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
        expect(headings).toEqual(['Chat Model Tiers', 'EU Chat Model Tiers', 'Custom Tiers', 'Background models', 'Automations']);
        // Nothing changed yet: no save bar, and no Save button of its own on any section.
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    });

    it('stores only the parts that changed, with one Save, and the bar goes away', async () => {
        const user = userEvent.setup();
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        await screen.findByText('Background models');
        const tierRow = screen.getAllByRole('heading', { level: 3 })[0].closest('section') as HTMLElement;
        await user.click(within(tierRow).getAllByTestId('picker')[0]);
        const automations = screen.getByRole('heading', { name: 'Automations' }).closest('section') as HTMLElement;
        await user.click(within(automations).getAllByTestId('picker')[0]);

        expect(screen.getByText('Unsaved changes')).toBeTruthy();
        fetchMock.mockClear();
        fetchMock.mockImplementation(async (url: string) => json(String(url).includes('ai-step-model') ? { success: true, modelId: 'qwen3:8b' } : { success: true }));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'));
        const sent = posts();
        expect(sent.map(([path]) => path).sort()).toEqual(['ai-step-model', 'chat-models']);
        expect(sent.find(([path]) => path === 'chat-models')?.[1].fast.modelId).toBe('qwen3:8b');
        expect(sent.find(([path]) => path === 'ai-step-model')?.[1]).toEqual({ modelId: 'qwen3:8b' });
        expect(screen.queryByText('Unsaved changes')).toBeNull();
    });

    it('a refused part stays in the draft and the bar says so', async () => {
        const user = userEvent.setup();
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        await screen.findByText('Background models');
        const automations = screen.getByRole('heading', { name: 'Automations' }).closest('section') as HTMLElement;
        await user.click(within(automations).getAllByTestId('picker')[0]);
        fetchMock.mockImplementation(async () => json({ error: 'Model "qwen3:8b" not found in any configured provider' }, 400));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('not found in any configured provider'));
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    });

    it('Discard puts the draft back to what is stored', async () => {
        const user = userEvent.setup();
        render(<ChatModelTiersConfig allModels={[MISTRAL, LOCAL]} />);
        await screen.findByText('Background models');
        const automations = screen.getByRole('heading', { name: 'Automations' }).closest('section') as HTMLElement;
        await user.click(within(automations).getAllByTestId('picker')[0]);
        expect(within(automations).getAllByTestId('picker')[0].textContent).toBe('qwen3:8b');
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        expect(within(automations).getAllByTestId('picker')[0].textContent).toBe('— Use the step\'s own tier —');
        expect(screen.queryByText('Unsaved changes')).toBeNull();
    });
});
