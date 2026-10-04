import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    API_BASE: '',
    authFetch: (...args) => authFetch(...args),
}));

import AutomationPicker from './AutomationPicker';

/**
 * "Nieuwe vanuit deze knop" mag alleen door de EIGENAAR van de app.
 *
 * De automatisering die hier ontstaat wordt door één app-actie gedraaid, en die actie
 * draait als de app-eigenaar. Onder de klikker gemaakt is de knop stuk vanaf de
 * eerste druk; onder de eigenaar gemaakt terwijl iemand anders klikt is erger —
 * dan heeft die iemand een automatisering geschreven die met andermans rechten draait.
 * De server weigert (crud.js → appRefOwnerVerdict); dit bestand gaat over wat
 * de gebruiker daarvan te zien krijgt.
 *
 * De valkuil die het afdekt: de rij had één tak voor élke 403 en die zei
 * "Automations are not part of this plan". Een eigendomsweigering kwam dus op het
 * scherm aan als een factureringsprobleem, en de enige aangeboden uitweg was de
 * verkeerde.
 */

const authFetch = vi.fn();
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const refuse = (status, body) => ({
    ok: false, status, json: async () => body, text: async () => JSON.stringify(body),
});

const REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

const onPick = vi.fn();

/** Render the picker and press "Make an automation for this app". */
async function tryToCreate(failure) {
    authFetch.mockImplementation(async (url, init) => {
        if (init?.method === 'POST') return failure;
        return ok({ automations: [] });
    });
    render(<AutomationPicker open onClose={() => {}} onPick={onPick} formFields={[]} appRef={REF} />);
    await userEvent.click(await screen.findByRole('button', { name: /Make an automation for this app/ }));
    await waitFor(() => expect(authFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
}

beforeEach(() => { cleanup(); authFetch.mockReset(); onPick.mockReset(); });
afterEach(cleanup);

describe('een eigendomsweigering leest als een eigendomsweigering', () => {
    it('zegt dat de app van iemand anders is, en biedt de werkende uitweg', async () => {
        await tryToCreate(refuse(403, {
            error: 'This app belongs to somebody else. An automation made here would run with the app owner\'s permissions, so only the owner can make one from this button.',
            code: 'owner_mismatch',
        }));
        expect(await screen.findByText(/only the app owner can make one/i)).toBeTruthy();
        expect(screen.queryByText(/not part of this plan/i)).toBeNull();
        expect(onPick).not.toHaveBeenCalled();
    });

    it('zegt bij een ONLEESBARE eigenaar dat het niet na te gaan was — geen gok, geen "het lukte niet"', async () => {
        await tryToCreate(refuse(403, { error: 'The app … could not be read …', code: 'app_unknown' }));
        expect(await screen.findByText(/could not be read, so it is not clear who the automation would belong to/i)).toBeTruthy();
        expect(onPick).not.toHaveBeenCalled();
    });

    it('zegt bij een app zonder eigenaar niet dat het aan het abonnement ligt', async () => {
        await tryToCreate(refuse(403, { error: 'no owner', code: 'owner_unknown' }));
        expect(await screen.findByText(/does not say who owns it/i)).toBeTruthy();
        expect(screen.queryByText(/not part of this plan/i)).toBeNull();
    });
});

describe('en de licentieweigering blijft zijn eigen zin houden', () => {
    // Op de CODE, niet op de zin. `/api/automation` zit achter
    // requireLicenseFeature('automations') → requireFeature, en die antwoordt
    // letterlijk `{ error: 'feature_locked' }` (server/license/middleware.js).
    // In dat woord zit noch "tier_required" noch "licen", dus de oude
    // prozamatch was onbereikbaar voor de poort die er echt staat en de
    // gebruiker las de kale servertekst `feature_locked` in het rode zinnetje.
    it('herkent feature_locked — het antwoord dat requireFeature ECHT stuurt', async () => {
        await tryToCreate(refuse(403, {
            error: 'feature_locked', feature: 'automations', required: 'team', current: 'free',
        }));
        expect(await screen.findByText(/Automations are not part of this plan/i)).toBeTruthy();
        expect(screen.queryByText(/belongs to someone else/i)).toBeNull();
        expect(screen.queryByText(/^feature_locked$/)).toBeNull();
    });

    it('en tier_unavailable krijgt een ANDERE zin — dat is "probeer zo nog eens", geen upgrade', async () => {
        await tryToCreate(refuse(503, { error: 'tier_unavailable', retry_after: 1 }));
        expect(await screen.findByText(/could not be checked just now/i)).toBeTruthy();
        expect(screen.queryByText(/not part of this plan/i)).toBeNull();
    });

    it('een uitgeschakelde module (404 not_found) leest ook niet als een abonnement', async () => {
        await tryToCreate(refuse(404, { error: 'not_found' }));
        expect(await screen.findByText(/Automations are switched off here/i)).toBeTruthy();
    });

    it('laat een onbekende fout gewoon zien in plaats van hem een reden aan te praten', async () => {
        await tryToCreate(refuse(500, { error: 'Something exploded' }));
        expect(await screen.findByText('Something exploded')).toBeTruthy();
        expect(screen.queryByText(/not part of this plan/i)).toBeNull();
        expect(screen.queryByText(/belongs to someone else/i)).toBeNull();
    });
});
