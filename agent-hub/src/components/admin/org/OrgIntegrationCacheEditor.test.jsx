import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@/test/http';
import OrgIntegrationCacheEditor from './OrgIntegrationCacheEditor';
import { authFetch } from '../../../utils/helpers';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

const envelope = (over = {}) => ({
    enabled: true,
    ttlSeconds: 300,
    configured: true,
    killSwitch: false,
    ttlRange: { min: 60, max: 3600 },
    entries: 0,
    expiredEntries: 0,
    bytes: 0,
    ...over,
});

/**
 * What this screen has to be honest about is HOW MUCH of somebody's data is
 * sitting in the database right now — so the count includes expired-but-present
 * rows (the prune is hourly) and the purge button is offered on that same
 * number, because the purge deletes everything either way.
 */
describe('OrgIntegrationCacheEditor', () => {
    beforeEach(() => { cleanup(); authFetch.mockReset(); });

    it('offers the purge button when the only rows left have EXPIRED', async () => {
        // Reporting live entries only told an org it held nothing while
        // thousands of rows sat there between prune passes — and hid the one
        // button that would have deleted them.
        authFetch.mockImplementation(() => ok(envelope({ entries: 0, expiredEntries: 40, bytes: 4096 })));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/Delete the 40 stored answer\(s\) now/)).toBeTruthy();
    });

    it('reports the size, not just the count', async () => {
        authFetch.mockImplementation(() => ok(envelope({ entries: 3, expiredEntries: 1, bytes: 2 * 1024 * 1024 })));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/Stored right now: 4 answer\(s\), 2\.0 MB\./)).toBeTruthy();
        expect(screen.getByText(/1 of those have already expired/)).toBeTruthy();
    });

    it('says nothing about stored answers when there are none', async () => {
        authFetch.mockImplementation(() => ok(envelope()));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByText(/Stored right now/)).toBeNull();
        expect(screen.queryByText(/Delete the/)).toBeNull();
    });

    it('tolerates a server that has not been redeployed yet', async () => {
        // The extra counters are new; an older API answers with `entries` only,
        // and a NaN in the button label is worse than the old behaviour.
        authFetch.mockImplementation(() => ok({
            enabled: true, ttlSeconds: 300, configured: true, killSwitch: false,
            ttlRange: { min: 60, max: 3600 }, entries: 5,
        }));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/Delete the 5 stored answer\(s\) now/)).toBeTruthy();
        expect(screen.getByText(/Stored right now: 5 answer\(s\), 0 B\./)).toBeTruthy();
    });
});

/**
 * The two scope ticks.
 *
 * One decision ("may third-party response payloads be stored at rest here"),
 * one config row, two ticks inside it — because two config keys would let an
 * org sit half-on with nobody able to see which half. But an admin who
 * consented to "what a connected app answers" did not consent to arbitrary
 * outbound HTTP, so the widening needs a fresh tick rather than a reworded
 * screen.
 */
describe('OrgIntegrationCacheEditor — what may be kept', () => {
    beforeEach(() => { cleanup(); authFetch.mockReset(); });

    const appTick = () => screen.getByRole('checkbox', { name: /Answers from connected apps/i });
    const httpTick = () => screen.getByRole('checkbox', { name: /Answers from web service calls/i });

    it('shows both ticks once the feature is on', async () => {
        authFetch.mockImplementation(() => ok(envelope({ scopes: { integration: true, http: false } })));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(appTick().checked).toBe(true);
        expect(httpTick().checked).toBe(false);
    });

    it('hides them while the feature is off — there is nothing to scope', async () => {
        authFetch.mockImplementation(() => ok(envelope({ enabled: false })));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByRole('checkbox', { name: /Answers from web service calls/i })).toBeNull();
    });

    it('a server that predates scopes reads as app-look-ups ON, outbound HTTP OFF', async () => {
        // Exactly what integrationCachePolicy.normalizeScopes derives and what
        // the migration stamps, so the screen never shows a state the server
        // would not agree with.
        authFetch.mockImplementation(() => ok(envelope()));   // no `scopes` key
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(appTick().checked).toBe(true);
        expect(httpTick().checked).toBe(false);
    });

    it('ticking outbound HTTP is a change worth saving, and is what gets sent', async () => {
        authFetch.mockImplementation(() => ok(envelope({ scopes: { integration: true, http: false } })));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());

        const save = screen.getByRole('button', { name: /^Save$/i });
        expect(save.disabled).toBe(true);
        fireEvent.click(httpTick());
        expect(save.disabled).toBe(false);

        authFetch.mockClear();
        authFetch.mockImplementation(() => ok(envelope({ scopes: { integration: true, http: true } })));
        fireEvent.click(save);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        const put = authFetch.mock.calls.find(([, init]) => init && init.method === 'PUT');
        expect(put).toBeTruthy();
        expect(JSON.parse(put[1].body).scopes).toEqual({ integration: true, http: true });
    });

    it('the copy names outbound web service calls, not just apps', async () => {
        authFetch.mockImplementation(() => ok(envelope()));
        render(<OrgIntegrationCacheEditor orgId="org-a" />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.getByText(/or of a web service they call directly/i)).toBeTruthy();
    });
});
