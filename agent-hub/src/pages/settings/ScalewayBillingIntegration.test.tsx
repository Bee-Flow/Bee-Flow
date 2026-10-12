import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The card is about which body it posts; the network seam is authFetch.
const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args: unknown[]) => authFetch(...args) }));

import ScalewayBillingIntegration from './ScalewayBillingIntegration';

const KEY = '11111111-2222-4333-8444-555555555555';
const ORG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const postedBody = () => JSON.parse(authFetch.mock.calls[0][1].body);

async function open(connected: boolean, onSaved = vi.fn()) {
    const user = userEvent.setup();
    render(<ScalewayBillingIntegration hasScalewayBillingConfig={connected} onSaved={onSaved} />);
    await user.click(screen.getByText('Scaleway Billing'));
    return user;
}

describe('ScalewayBillingIntegration', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    });
    afterEach(cleanup);

    it('will not connect with only an organization id', async () => {
        const user = await open(false);
        await user.type(screen.getByRole('textbox'), ORG);
        expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('posts the trimmed secret key and organization id', async () => {
        const onSaved = vi.fn();
        const user = await open(false, onSaved);
        await user.type(screen.getByRole('textbox'), ` ${ORG} `);
        await user.type(document.querySelector('input[type="password"]') as HTMLInputElement, ` ${KEY} `);
        await user.click(screen.getByRole('button', { name: /^save$/i }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody()).toEqual({ scalewayBillingSecretKey: KEY, scalewayBillingOrgId: ORG });
    });

    it('clears both settings on disconnect', async () => {
        const user = await open(true);
        await user.click(screen.getByRole('button', { name: /^disconnect$/i }));
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(postedBody()).toEqual({ scalewayBillingSecretKey: '', scalewayBillingOrgId: '' });
    });
});
