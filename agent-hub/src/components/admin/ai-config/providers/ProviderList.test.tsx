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
            rerankerConnected={false}
            selectedId="claude"
            onSelect={onSelect}
            {...over}
        />,
    );
    return onSelect;
};

describe('ProviderList', () => {
    it('groups providers into Connected, Available and Local with a count each', () => {
        renderList();
        const connected = screen.getByRole('region', { name: 'Connected' });
        const available = screen.getByRole('region', { name: 'Available' });
        const local = screen.getByRole('region', { name: 'Local' });
        expect(within(connected).getAllByRole('button')).toHaveLength(2);
        expect(within(connected).getByText('2')).toBeTruthy();
        expect(within(available).getAllByRole('button')).toHaveLength(PROVIDER_REGISTRY.length - 2);
        expect(within(local).getByRole('button', { name: /GPU box/ })).toBeTruthy();
    });

    it('shows the model count on connected providers only', () => {
        renderList();
        expect(within(screen.getByRole('button', { name: /Claude/ })).getByText('4')).toBeTruthy();
        // OpenAI has models in the counts but no key: no count in the row.
        expect(within(screen.getByRole('button', { name: /OpenAI/ })).queryByText('9')).toBeNull();
    });

    it('marks the selected row and reports a click', async () => {
        const user = userEvent.setup();
        const onSelect = renderList();
        expect(screen.getByRole('button', { name: /Claude/ }).getAttribute('aria-current')).toBe('true');
        expect(screen.getByRole('button', { name: /Mistral/ }).getAttribute('aria-current')).toBeNull();
        await user.click(screen.getByRole('button', { name: /OpenAI/ }));
        expect(onSelect).toHaveBeenCalledWith('openai');
        await user.click(screen.getByRole('button', { name: /GPU box/ }));
        expect(onSelect).toHaveBeenCalledWith(localPaneId('ollama-1'));
        await user.click(screen.getByRole('button', { name: 'Reranker' }));
        expect(onSelect).toHaveBeenCalledWith('reranker');
        await user.click(screen.getByRole('button', { name: 'Add local runtime' }));
        expect(onSelect).toHaveBeenCalledWith('add-local');
    });

    it('leaves out a group that is empty', () => {
        renderList({ connectedIds: new Set(), localProviders: [] });
        expect(screen.queryByRole('region', { name: 'Connected' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Local' })).toBeNull();
        expect(screen.getByRole('region', { name: 'Available' })).toBeTruthy();
    });
});
