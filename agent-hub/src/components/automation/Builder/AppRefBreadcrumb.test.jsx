import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

import AppRefBreadcrumb from './AppRefBreadcrumb';
import { __clearAppRefCacheForTests } from './flow/appRefLabel';

/**
 * The way back from the builder to the button that opened it.
 *
 * The strip names an app and a screen the viewer may not be allowed to open,
 * so every assertion here is really about one rule: it renders what the server
 * told it and nothing else. A guessed name is a leak; a link that lands on a
 * refusal is worse than no link; and a pointer to a deleted screen is
 * something to SAY, not something to hide.
 */

const authFetch = vi.fn();
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

beforeEach(() => {
    cleanup();
    authFetch.mockReset();
    __clearAppRefCacheForTests();
});
afterEach(cleanup);

describe('a reference the viewer owns', () => {
    beforeEach(() => {
        authFetch.mockResolvedValue(ok({
            status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', nodeLabel: 'Submit claim', canOpen: true,
        }));
    });

    it('draws App › Screen › button', async () => {
        render(<AppRefBreadcrumb appRef={REF} />);
        expect(await screen.findByText('Expenses')).toBeTruthy();
        expect(screen.getByText('Dashboard')).toBeTruthy();
        expect(screen.getByText('Submit claim')).toBeTruthy();
    });

    it('links the app, and only the app', async () => {
        const { container } = render(<AppRefBreadcrumb appRef={REF} />);
        await screen.findByText('Expenses');
        const links = container.querySelectorAll('a');
        expect(links.length).toBe(1);
        expect(links[0].getAttribute('href')).toBe(`/app/studio/apps/${REF.appId}`);
    });

    it('asks the server about exactly this reference', async () => {
        render(<AppRefBreadcrumb appRef={REF} />);
        await screen.findByText('Expenses');
        expect(authFetch).toHaveBeenCalledTimes(1);
        const url = authFetch.mock.calls[0][0];
        expect(url).toContain(`/api/studio-apps/${REF.appId}/ref`);
        expect(url).toContain('screenId=scr_dash01');
        expect(url).toContain('nodeId=cmp_btn123');
    });
});

describe('a reference the viewer may not be told about', () => {
    it('shows the ids, no name, and NO link', async () => {
        authFetch.mockResolvedValue(ok({
            status: 'restricted', ...REF, appName: null, screenName: null, nodeLabel: null, canOpen: false,
        }));
        const { container } = render(<AppRefBreadcrumb appRef={REF} />);
        await screen.findByText(REF.appId);
        expect(container.querySelectorAll('a').length).toBe(0);
        expect(screen.getByText(/belongs to someone else/)).toBeTruthy();
    });

    it('never invents a link from `canOpen` being absent', async () => {
        // Missing is not true. A body without the flag must not produce a link
        // that lands on a refusal.
        authFetch.mockResolvedValue(ok({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard' }));
        const { container } = render(<AppRefBreadcrumb appRef={REF} />);
        await screen.findByText('Expenses');
        expect(container.querySelectorAll('a').length).toBe(0);
    });
});

describe('a reference that points at nothing any more', () => {
    it('says the app is gone', async () => {
        authFetch.mockResolvedValue(ok({ status: 'app_missing', ...REF, canOpen: false }));
        render(<AppRefBreadcrumb appRef={REF} />);
        expect(await screen.findByText('App no longer exists')).toBeTruthy();
    });

    it('says the screen is gone while still naming and linking the app', async () => {
        authFetch.mockResolvedValue(ok({ status: 'screen_missing', ...REF, appName: 'Expenses', canOpen: true }));
        const { container } = render(<AppRefBreadcrumb appRef={REF} />);
        expect(await screen.findByText('Screen no longer exists')).toBeTruthy();
        expect(screen.getByText('Expenses')).toBeTruthy();
        expect(container.querySelectorAll('a').length).toBe(1);
    });

    it('says the button is gone', async () => {
        authFetch.mockResolvedValue(ok({ status: 'node_missing', ...REF, appName: 'Expenses', screenName: 'Dashboard', canOpen: true }));
        render(<AppRefBreadcrumb appRef={REF} />);
        expect(await screen.findByText('Button no longer exists')).toBeTruthy();
    });
});

describe('nothing to draw', () => {
    it('renders nothing without a reference, and asks nothing', () => {
        const { container } = render(<AppRefBreadcrumb appRef={null} />);
        expect(container.textContent).toBe('');
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('renders nothing while the answer is still in flight', async () => {
        let settle;
        authFetch.mockReturnValue(new Promise((r) => { settle = r; }));
        const { container } = render(<AppRefBreadcrumb appRef={REF} />);
        // Ids would flash and be replaced by names a moment later — worse than
        // an empty strip that fills in once.
        expect(container.textContent).toBe('');
        settle(ok({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', canOpen: true }));
        await waitFor(() => expect(container.textContent).toContain('Expenses'));
    });

    it('shows the ids and admits it could not check when the lookup fails', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        render(<AppRefBreadcrumb appRef={REF} />);
        expect(await screen.findByText(REF.appId)).toBeTruthy();
        expect(screen.getByText(/could not be checked/)).toBeTruthy();
    });
});

/**
 * DE CACHE STERFT MET DE SESSIE.
 *
 * De sleutel is `appId + screenId + nodeId` en noemt de kijker niet, terwijl
 * het antwoord per kijker verschilt: een app die je niet bezit levert
 * `restricted` — geen namen, geen link. Uitloggen herlaadt de pagina niet
 * (AuthedApp's handleLogout rendert het loginscherm in dezelfde JS-context),
 * dus zonder een opruimer leest de VOLGENDE gebruiker op hetzelfde werkstation
 * binnen 60 s de appnaam, schermnaam, knoplabel én `canOpen:true` van de
 * vorige. Dat zijn precies de twee dingen die appRefLookup.js verbiedt.
 */
describe('uitloggen wist wat deze kijker mocht zien', () => {
    it('clearSessionCaches() laat de volgende lezer opnieuw vragen', async () => {
        const { loadAppRef } = await import('./flow/appRefLabel');
        const { clearSessionCaches } = await import('../../../hooks/sessionCaches');

        authFetch.mockResolvedValue(ok({ status: 'ok', ...REF, appName: 'Expenses', canOpen: true }));
        expect((await loadAppRef(REF)).appName).toBe('Expenses');
        expect(authFetch).toHaveBeenCalledTimes(1);
        // Binnen het TTL-venster: geen tweede verzoek, dus dit IS een cache.
        await loadAppRef(REF);
        expect(authFetch).toHaveBeenCalledTimes(1);

        clearSessionCaches();

        // De volgende gebruiker op dezelfde browser krijgt het antwoord dat de
        // server HEM geeft, niet dat van zijn voorganger.
        authFetch.mockResolvedValue(ok({ status: 'restricted', ...REF, canOpen: false }));
        const second = await loadAppRef(REF);
        expect(authFetch).toHaveBeenCalledTimes(2);
        expect(second.status).toBe('restricted');
        expect(second.appName).toBeUndefined();
    });
});
