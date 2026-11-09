import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AIConfigPanel from './index';
import { aiConfigPath, sectionIdOf } from './aiConfigSections';
import { withQueryClient } from '@/test/queryWrapper';

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: string) => {
        const body = String(url).includes('/ai/providers') ? { providers: [] }
            : String(url).includes('/ai/local-runtimes') ? { runtimes: [], models: [] }
                : { hasClaudeKey: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
});

const renderPanel = (props: React.ComponentProps<typeof AIConfigPanel> = {}) => {
    const onNavigate = vi.fn();
    render(withQueryClient(<AIConfigPanel onNavigate={onNavigate} {...props} />));
    return onNavigate;
};

describe('section and provider paths', () => {
    it('builds the URL of a section and of a provider', () => {
        expect(aiConfigPath('providers')).toBe('admin/ai-config/providers');
        expect(aiConfigPath('providers', 'claude')).toBe('admin/ai-config/providers/claude');
        expect(aiConfigPath('web-search')).toBe('admin/ai-config/web-search');
    });

    it('reads a section from a URL id or from an old tab name', () => {
        expect(sectionIdOf('limits')).toBe('limits');
        expect(sectionIdOf('webSearchInference')).toBe('web-search');
        expect(sectionIdOf('chatModels')).toBe('chat-models');
        expect(sectionIdOf('nope')).toBeNull();
        expect(sectionIdOf(undefined)).toBeNull();
    });
});

describe('AIConfigPanel', () => {
    it('shows the provider the URL names, and marks the providers section as current', async () => {
        renderPanel({ activeSection: 'providers', activeProvider: 'mistral' });
        expect(await screen.findByRole('heading', { name: 'Mistral' })).toBeTruthy();
        expect(screen.getByRole('button', { name: /API Keys/ }).getAttribute('aria-current')).toBe('page');
        expect(screen.getByRole('button', { name: /Mistral/ }).getAttribute('aria-current')).toBe('true');
    });

    it('falls back to the providers section for an unknown one, and to the first connected provider', async () => {
        renderPanel({ activeSection: 'bogus' });
        expect(await screen.findByRole('heading', { name: 'Claude' })).toBeTruthy();
        expect(screen.getByRole('button', { name: /API Keys/ }).getAttribute('aria-current')).toBe('page');
    });

    it('navigates to the URL of the section or provider that is clicked', async () => {
        const user = userEvent.setup();
        const onNavigate = renderPanel({ activeSection: 'providers', activeProvider: 'claude' });
        await screen.findByRole('heading', { name: 'Claude' });
        await user.click(screen.getByRole('button', { name: /OpenAI/ }));
        expect(onNavigate).toHaveBeenLastCalledWith('admin/ai-config/providers/openai');
        await user.click(screen.getByRole('button', { name: /Embeddings/ }));
        expect(onNavigate).toHaveBeenLastCalledWith('admin/ai-config/embeddings');
    });
});
