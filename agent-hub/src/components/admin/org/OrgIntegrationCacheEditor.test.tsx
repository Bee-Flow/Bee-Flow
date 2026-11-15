import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@/test/http';
import { renderWithClient } from '@/test/render';
import { authFetch } from '@/utils/helpers';
import OrgIntegrationCacheEditor from './OrgIntegrationCacheEditor';
import { toast } from '../../shared/Toast';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const fetchMock = vi.mocked(authFetch);
/** The server's answer as the editor's fetch sees it (a Response is all it reads). */
const answer = (body: unknown) => ok(body) as unknown as Promise<Response>;

const envelope = (over: Record<string, unknown> = {}) => ({
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

/** The body of the PUT the editor sent, parsed. */
function putBody(): { scopes?: unknown } {
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put).toBeTruthy();
    return JSON.parse(String(put?.[1]?.body));
}

/** The read answered and the editor replaced its loading line. */
const loaded = () => waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByText(/Loading/)).toBeNull();
});

/**
 * What this screen has to be honest about is HOW MUCH of somebody's data is
 * sitting in the database right now — so the count includes expired-but-present
 * rows (the prune is hourly) and the purge button is offered on that same
 * number, because the purge deletes everything either way.
 */
describe('OrgIntegrationCacheEditor', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); });

    it('offers the purge button when the only rows left have EXPIRED', async () => {
        // Reporting live entries only told an org it held nothing while
        // thousands of rows sat there between prune passes — and hid the one
        // button that would have deleted them.
        fetchMock.mockImplementation(() => answer(envelope({ entries: 0, expiredEntries: 40, bytes: 4096 })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByRole('button', { name: 'Delete the 40 stored answers now' })).toBeTruthy();
    });

    it('reports the size, not just the count, in the singular and the plural', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ entries: 3, expiredEntries: 1, bytes: 2 * 1024 * 1024 })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/Stored right now: 4 answers, 2\.0 MB\./)).toBeTruthy();
        expect(screen.getByText(/1 of those has already expired/)).toBeTruthy();
    });

    it('one stored answer is one answer, not "answer(s)"', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ entries: 1, bytes: 10 })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/Stored right now: 1 answer, 10 B\./)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Delete the stored answer now' })).toBeTruthy();
        expect(screen.queryByText(/\(s\)/)).toBeNull();
    });

    it('says nothing about stored answers when there are none', async () => {
        fetchMock.mockImplementation(() => answer(envelope()));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(screen.queryByText(/Stored right now/)).toBeNull();
        expect(screen.queryByText(/Delete the/)).toBeNull();
    });

    it('tolerates a server that has not been redeployed yet', async () => {
        // The extra counters are new; an older API answers with `entries` only,
        // and a NaN in the button label is worse than the old behaviour.
        fetchMock.mockImplementation(() => answer({
            enabled: true, ttlSeconds: 300, configured: true, killSwitch: false,
            ttlRange: { min: 60, max: 3600 }, entries: 5,
        }));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByRole('button', { name: 'Delete the 5 stored answers now' })).toBeTruthy();
        expect(screen.getByText(/Stored right now: 5 answers, 0 B\./)).toBeTruthy();
    });

    it('deleting asks first; cancelling deletes nothing', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ entries: 2, bytes: 10 })));
        const user = userEvent.setup();
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);

        await user.click(await screen.findByRole('button', { name: 'Delete the 2 stored answers now' }));
        expect(screen.getByText('Delete the stored answers?')).toBeTruthy();
        await user.click(screen.getByTestId('confirm-dialog-cancel'));
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('a purge that never reached the server says so', async () => {
        // The stored answers are still there; a silent failure would read as
        // "deleted" to an admin who clicked and looked away.
        const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        fetchMock.mockImplementation((_url, init) => (init?.method === 'DELETE'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : answer(envelope({ entries: 2, bytes: 10 }))));
        const user = userEvent.setup();
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);

        await user.click(await screen.findByRole('button', { name: 'Delete the 2 stored answers now' }));
        await user.click(screen.getByTestId('confirm-dialog-confirm'));

        await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Could not clear the stored answers'));
        expect(screen.getByRole('button', { name: 'Delete the 2 stored answers now' })).toBeEnabled();
        errorSpy.mockRestore();
    });

    it('the reuse window reads in whole minutes, singular and plural', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ ttlSeconds: 60 })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(screen.getByLabelText('How long an answer may be reused')).toHaveAttribute('aria-valuetext', '1 minute');
    });

    it('the operator\'s server-wide switch is said in the warning colours', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ killSwitch: true })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        expect(await screen.findByText(/switched off for the whole server by its operator/)).toBeTruthy();
    });
});

/**
 * The scope switches.
 *
 * One decision ("may third-party response payloads be stored at rest here"),
 * one config row, three switches inside it — because separate config keys
 * would let an org sit half-on with nobody able to see which half. But an
 * admin who consented to "what a connected app answers" did not consent to
 * arbitrary outbound HTTP, so the widening needs a fresh switch rather than a
 * reworded screen.
 */
describe('OrgIntegrationCacheEditor — what may be kept', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); });

    const appTick = () => screen.getByRole('switch', { name: /Answers from connected apps/i });
    const httpTick = () => screen.getByRole('switch', { name: /Answers from web service calls/i });
    const aiTick = () => screen.getByRole('switch', { name: /Answers from AI steps/i });
    const saveButton = () => screen.getByRole('button', { name: /^Save$/i });

    it('shows the switches once the feature is on', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: false } })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(appTick()).toBeChecked();
        expect(httpTick()).not.toBeChecked();
    });

    it('hides them while the feature is off — there is nothing to scope', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ enabled: false })));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(screen.queryByRole('switch', { name: /Answers from web service calls/i })).toBeNull();
    });

    it('a server that predates scopes reads as app-look-ups ON, outbound HTTP OFF', async () => {
        // Exactly what integrationCachePolicy.normalizeScopes derives and what
        // the migration stamps, so the screen never shows a state the server
        // would not agree with.
        fetchMock.mockImplementation(() => answer(envelope()));   // no `scopes` key
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(appTick()).toBeChecked();
        expect(httpTick()).not.toBeChecked();
    });

    it('switching outbound HTTP on is a change worth saving, and is what gets sent', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: false, ai: false } })));
        const user = userEvent.setup();
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();

        expect(saveButton()).toBeDisabled();
        await user.click(httpTick());
        expect(saveButton()).toBeEnabled();

        fetchMock.mockClear();
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: true, ai: false } })));
        await user.click(saveButton());
        await loaded();
        await waitFor(() => expect(putBody().scopes).toEqual({ integration: true, http: true, ai: false }));
    });

    it('answers from AI steps are off by default, also for a server that predates the setting', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: false } })));   // no `ai` key
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(aiTick()).not.toBeChecked();
        expect(saveButton()).toBeDisabled();
    });

    it('switching AI answers on is a change worth saving, and is what gets sent', async () => {
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: false, ai: false } })));
        const user = userEvent.setup();
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();

        await user.click(aiTick());
        expect(saveButton()).toBeEnabled();

        fetchMock.mockClear();
        fetchMock.mockImplementation(() => answer(envelope({ scopes: { integration: true, http: false, ai: true } })));
        await user.click(saveButton());
        await loaded();
        await waitFor(() => expect(putBody().scopes).toEqual({ integration: true, http: false, ai: true }));
        await waitFor(() => expect(aiTick()).toBeChecked());
    });

    it('says what is stored and that test runs never use it', async () => {
        fetchMock.mockImplementation(() => answer(envelope()));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(screen.getByText(/same \(privacy-protected\) input, the stored answer is reused/i)).toBeTruthy();
        expect(screen.getByText(/never used in test runs/i)).toBeTruthy();
    });

    it('the copy names outbound web service calls and AI steps, not just apps', async () => {
        fetchMock.mockImplementation(() => answer(envelope()));
        renderWithClient(<OrgIntegrationCacheEditor orgId="org-a" />);
        await loaded();
        expect(screen.getByText(/of a web service they call directly, or of an AI model in an AI step/i)).toBeTruthy();
    });
});
