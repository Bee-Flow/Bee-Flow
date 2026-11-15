import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ProviderList from './ProviderList';
import { PROVIDER_REGISTRY, localPaneId } from './providerRegistry';

const renderList = (over: Partial<React.ComponentProps<typeof ProviderList>> = {}) => {
    const onSelect = vi.fn();
    render(
        <ProviderList
            entries={PROVIDER_REGISTRY}
            connectedIds={new Set(['claude', 'mistral'])}
            modelCounts={{ claude: 4, mistral: 3, openai: 9 }}
            localProviders={[{ id: 'ollama-1', name: 'GPU box', type: 'ollama' }]}
            selectedId="claude"
            onSelect={onSelect}
            {...over}
        />,
    );
    return onSelect;
};

const names = (region: HTMLElement) => within(region).getAllByRole('button').map(b => b.textContent);

describe('ProviderList', () => {
    // A voice and sound provider sat among the language models, under a hint
    // that its models would show up as chat models. It has a group of its own.
    it('groups providers by what they serve: language models, speech & media, self-hosted', () => {
        renderList();
        const language = screen.getByRole('region', { name: 'Language models' });
        const media = screen.getByRole('region', { name: 'Speech & media' });
        const local = screen.getByRole('region', { name: 'Self-hosted' });
        expect(within(media).getAllByRole('button')).toHaveLength(1);
        expect(within(media).getByRole('button', { name: /ElevenLabs/ })).toBeTruthy();
        expect(within(language).queryByRole('button', { name: /ElevenLabs/ })).toBeNull();
        expect(within(language).getAllByRole('button')).toHaveLength(PROVIDER_REGISTRY.length - 1);
        expect(within(local).getByRole('button', { name: /GPU box/ })).toBeTruthy();
    });

    it('puts the connected providers of a group first', () => {
        renderList();
        const first = names(screen.getByRole('region', { name: 'Language models' })).slice(0, 3);
        expect(first[0]).toContain('Mistral');
        expect(first[1]).toContain('Claude');
        expect(first[2]).not.toMatch(/Mistral|Claude/);
    });

    it('shows the model count on connected providers only', () => {
        renderList();
        expect(within(screen.getByRole('button', { name: /Claude/ })).getByText('4')).toBeTruthy();
        // OpenAI has models in the counts but no key: no count in the row.
        expect(within(screen.getByRole('button', { name: /OpenAI/ })).queryByText('9')).toBeNull();
    });

    it('marks the selected row and reports a click; the reranker is no longer a row here', async () => {
        const user = userEvent.setup();
        const onSelect = renderList();
        expect(screen.getByRole('button', { name: /Claude/ }).getAttribute('aria-current')).toBe('true');
        expect(screen.getByRole('button', { name: /Mistral/ }).getAttribute('aria-current')).toBeNull();
        await user.click(screen.getByRole('button', { name: /OpenAI/ }));
        expect(onSelect).toHaveBeenCalledWith('openai');
        await user.click(screen.getByRole('button', { name: /GPU box/ }));
        expect(onSelect).toHaveBeenCalledWith(localPaneId('ollama-1'));
        expect(screen.queryByRole('button', { name: 'Reranker' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Add local runtime' }));
        expect(onSelect).toHaveBeenCalledWith('add-local');
    });

    it('leaves out a group that is empty', () => {
        renderList({ localProviders: [], entries: PROVIDER_REGISTRY.filter(e => e.group === 'language') });
        expect(screen.queryByRole('region', { name: 'Speech & media' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Self-hosted' })).toBeNull();
        expect(screen.getByRole('region', { name: 'Language models' })).toBeTruthy();
    });
});
