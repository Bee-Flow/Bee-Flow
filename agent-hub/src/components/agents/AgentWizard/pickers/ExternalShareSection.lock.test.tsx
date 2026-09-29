import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * External links and a locked `webpage_sharing` (the enterprise split,
 * 2026-10): a NEW link is not offered, the links that exist keep their
 * refresh and revoke, and the server's refusal reads as a sentence.
 */

const authFetch = vi.fn();
vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args: unknown[]) => authFetch(...args),
}));
const entitlements: { loading: boolean; error: unknown; lockReason: (id: string) => string | null } = {
    loading: false, error: null, lockReason: () => null,
};
vi.mock('../../../licensing/EntitlementsContext', () => ({
    useEntitlements: () => entitlements,
}));

import ExternalShareSection from './ExternalShareSection';

const SHARE = { id: 'sh1', accessMode: 'unlisted', expiresAt: null, viewCount: 3, url: 'https://x/share/abc', revokedAt: null };
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
    authFetch.mockReset();
    entitlements.loading = false;
    entitlements.error = null;
    entitlements.lockReason = () => null;
});

describe('ExternalShareSection with webpage sharing locked', () => {
    it('offers no new link, and keeps refresh and revoke on the links that exist', async () => {
        entitlements.lockReason = (id) => (id === 'webpage_sharing' ? 'ceiling' : null);
        authFetch.mockResolvedValue(response({ shares: [SHARE] }));
        render(<ExternalShareSection webpageId="wp1" webpageName="Prijslijst" />);
        expect(await screen.findByTitle('Revoke link')).toBeTruthy();
        expect(screen.getByTitle('Re-snapshot — update the public copy to match current edits')).toBeTruthy();
        expect(screen.queryByText('New link')).toBeNull();
    });

    it('offers a new link when sharing is not locked', async () => {
        authFetch.mockResolvedValue(response({ shares: [] }));
        render(<ExternalShareSection webpageId="wp1" webpageName="Prijslijst" />);
        expect(await screen.findByText('New link')).toBeTruthy();
    });

    it('shows the server\'s licence refusal as a sentence, not as a token', async () => {
        // While the entitlements load, nothing is locked and the server decides.
        entitlements.loading = true;
        authFetch.mockResolvedValueOnce(response({ shares: [] }));
        render(<ExternalShareSection webpageId="wp1" webpageName="Prijslijst" />);
        await userEvent.click(await screen.findByText('New link'));
        authFetch.mockResolvedValueOnce(response({ error: 'feature_locked', feature: 'webpage_sharing', required: 'enterprise' }, false, 403));
        await userEvent.click(screen.getByText('Create link'));
        await waitFor(() => expect(screen.getByText(/higher plan/)).toBeTruthy());
        expect(screen.queryByText(/feature_locked/)).toBeNull();
    });
});
