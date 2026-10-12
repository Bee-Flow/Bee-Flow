import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicAppPage from './PublicAppPage';

afterEach(() => vi.unstubAllGlobals());

describe('PublicAppPage unavailable states', () => {
    it('says in English that the link does not exist (404)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
        render(<PublicAppPage token="t1" />);
        expect(await screen.findByText('This page does not exist (any more)')).toBeInTheDocument();
        expect(screen.getByText(/Ask the sender for a new link/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    it('offers a retry on other failures', async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetchMock);
        render(<PublicAppPage token="t1" />);
        expect(await screen.findByText('The page could not be loaded')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
