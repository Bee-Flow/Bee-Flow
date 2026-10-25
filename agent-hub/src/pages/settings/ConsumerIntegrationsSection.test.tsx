// Settings → Account → Integrations for a consumer account: one tile per tool
// the AI may call, pressed = on. Pinned: a click on the switch picture inside a
// tile toggles it exactly once (a nested label + checkbox used to toggle it
// twice, so the switch looked dead), and the choice is saved.
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithClient as render } from '../../test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import ConsumerIntegrationsSection from './ConsumerIntegrationsSection';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('ConsumerIntegrationsSection', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockImplementation(async (_url: string, opts?: { method?: string }) => (
            opts?.method === 'POST' ? ok({}) : ok({ enabledApps: [] })
        ));
    });
    afterEach(cleanup);

    it('a click on the switch inside a tile turns the tool on once and saves it', async () => {
        const user = userEvent.setup();
        render(<ConsumerIntegrationsSection />);

        const tile = await screen.findByRole('button', { name: /Gmail/ });
        expect(tile).toHaveAttribute('aria-pressed', 'false');

        await user.click(tile.querySelector('span[aria-hidden="true"]') as HTMLElement);
        expect(tile).toHaveAttribute('aria-pressed', 'true');

        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/ai/user-settings', expect.objectContaining({ method: 'POST' })));
        const post = authFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
        expect(JSON.parse(post?.[1].body).enabledApps).toEqual(['gmail']);
    });

    it('the tile has no checkbox of its own', async () => {
        render(<ConsumerIntegrationsSection />);
        await screen.findByRole('button', { name: /Gmail/ });
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });
});
