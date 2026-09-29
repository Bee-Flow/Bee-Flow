import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '@/test/http';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));

import SearchSection from './SearchSection';

/**
 * The provider selector and "Save Defaults" awaited the request but never
 * looked at the answer: a 403 (the defaults route is admin-only since
 * validation batch 3) still showed "saved". They now report the refusal.
 */

const noop = () => {};

function renderSection(setMessage = vi.fn()) {
    render(
        <SearchSection
            searchProvider="node-search" setSearchProvider={noop}
            bingSearchKey="" setBingSearchKey={noop} hasBingSearchKey={false} setHasBingSearchKey={noop}
            bingSearchMarket="en-US" setBingSearchMarket={noop} savingBingKey={false} setSavingBingKey={noop}
            agentSearchUrl="" hasAgentSearchUrl={false}
            serperApiKey="" setSerperApiKey={noop} hasSerperKey={false} setHasSerperKey={noop}
            savingSerperKey={false} setSavingSerperKey={noop}
            agentSearchDefaults={{ mode: 'web', include_citations: true, web: {}, web_fast: {} }}
            setAgentSearchDefaults={noop} savingSearchDefaults={false} setSavingSearchDefaults={noop}
            setMessage={setMessage}
        />,
    );
    return setMessage;
}

beforeEach(() => { authFetch.mockReset(); });

describe('SearchSection saves', () => {
    it('a refused "Save Defaults" reports an error, not success', async () => {
        authFetch.mockImplementation(() => fail(403, { error: 'forbidden' }));
        const setMessage = renderSection();
        await userEvent.setup().click(screen.getByRole('button', { name: /save defaults/i }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save defaults' }));
        expect(setMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('an accepted "Save Defaults" still reports success', async () => {
        authFetch.mockImplementation(() => ok({ ok: true }));
        const setMessage = renderSection();
        await userEvent.setup().click(screen.getByRole('button', { name: /save defaults/i }));
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'success', text: 'Agent Search defaults saved' }));
    });

    it('a refused provider change reports an error, not success', async () => {
        authFetch.mockImplementation(() => fail(403));
        const setMessage = renderSection();
        await userEvent.setup().selectOptions(screen.getByDisplayValue(/cloud-only/i), 'agent-search');
        await waitFor(() => expect(setMessage).toHaveBeenCalledWith({ type: 'error', text: 'Failed to save search provider' }));
        expect(setMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
});
