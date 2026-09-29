import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The audience panel and a locked `webpage_sharing` (the enterprise split,
 * 2026-10): making a page public is closed, turning it off never is, and the
 * server's refusal reads as a sentence. What the panel shows is the same line
 * the server draws in routes/webpages/sharingGate.js.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args: unknown[]) => authFetch(...args),
}));
vi.mock('../../components/shared/AudienceRows', () => ({
    default: () => <div data-testid="audience-rows" />,
}));
const entitlements: { loading: boolean; error: unknown; lockReason: (id: string) => string | null } = {
    loading: false, error: null, lockReason: () => null,
};
vi.mock('../../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => entitlements,
}));

import WebpageAudiencePanel from './WebpageAudiencePanel';

const MODEL = {
    internal: { mode: 'personal', isPublished: false, sharedGroups: [], organizationId: null },
    public: {
        on: false, shareId: null, accessMode: 'unlisted', hasPassword: false,
        allowedEmails: [], expiresAt: null, viewCount: 0, lastViewedAt: null,
        tablesReadOnly: true, agentRuns: false, aiKnown: true, aiRuns: false, aiGroundsOnPage: false,
    },
    address: null,
    columnGate: { tables: [], anyBound: false, sharingCount: 0 },
    shareCount: 0,
    solution: null,
};
const model = (publicOver = {}) => ({ ...JSON.parse(JSON.stringify(MODEL)), public: { ...MODEL.public, ...publicOver } });
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
    authFetch.mockReset();
    entitlements.loading = false;
    entitlements.error = null;
    entitlements.lockReason = () => null;
});

const renderPanel = () => render(<WebpageAudiencePanel webpageId="wp1" page={{ isPublished: false }} onSetPersonal={() => {}} />);

describe('WebpageAudiencePanel with webpage sharing locked', () => {
    it('closes "Make public" and says why, and what still works', async () => {
        entitlements.lockReason = (id) => (id === 'webpage_sharing' ? 'ceiling' : null);
        authFetch.mockResolvedValue(response(model()));
        renderPanel();
        const toggle = await screen.findByTestId('public-toggle') as HTMLButtonElement;
        expect(toggle.disabled).toBe(true);
        expect(screen.getByTestId('webpage-sharing-locked').textContent).toMatch(/higher plan/);
    });

    it('keeps "Turn off" open on a page that is already public', async () => {
        entitlements.lockReason = () => 'ceiling';
        authFetch.mockResolvedValueOnce(response(model({ on: true, shareId: 'sh1' })));
        renderPanel();
        const toggle = await screen.findByTestId('public-toggle') as HTMLButtonElement;
        expect(toggle.disabled).toBe(false);
        authFetch.mockResolvedValueOnce(response(model()));
        await userEvent.click(toggle);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
        const [url, init] = authFetch.mock.calls[1];
        expect(url).toMatch(/\/audience\/public$/);
        expect(JSON.parse(init.body)).toEqual({ on: false });
    });

    it('says "ask an admin" when the plan has it and the organisation did not switch it on', async () => {
        entitlements.lockReason = () => 'not_granted';
        authFetch.mockResolvedValue(response(model()));
        renderPanel();
        expect((await screen.findByTestId('webpage-sharing-locked')).textContent).toMatch(/ask an admin/);
    });

    it('while the entitlements load nothing is locked, and the server\'s refusal reads as a sentence', async () => {
        entitlements.loading = true;
        entitlements.lockReason = () => 'ceiling';
        authFetch.mockResolvedValueOnce(response(model()));
        renderPanel();
        const toggle = await screen.findByTestId('public-toggle') as HTMLButtonElement;
        expect(toggle.disabled).toBe(false);
        expect(screen.queryByTestId('webpage-sharing-locked')).toBeNull();
        authFetch.mockResolvedValueOnce(response({ error: 'feature_locked', feature: 'webpage_sharing', required: 'enterprise' }, false, 403));
        await userEvent.click(toggle);
        const shown = await screen.findByTestId('audience-save-error');
        expect(shown.textContent).toMatch(/higher plan/);
        expect(shown.textContent).not.toMatch(/feature_locked/);
    });
});
