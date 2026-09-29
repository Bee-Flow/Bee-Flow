import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageAppsPanel — de tweede zwaarste (57 letterlijke strings).
 *
 * t() is een MARKEERDER (`⟦sleutel⟧`). Wat hier vastligt is niet alleen DAT er
 * vertaald wordt, maar ook HOE: een naam die in een zin staat reist als
 * parameter mee, niet als een los stuk Engels dat aan de naam wordt geplakt.
 * Die vorm is het verschil tussen een vertaalbare zin en een halve.
 */

const t = (key, fallback, params) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

const CATALOG = {
    apps: [
        { id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_search', label: 'gmail search' }] },
        { id: 'youtrack', label: 'YouTrack', available: false, actions: [{ name: 'yt_get', label: 'yt get' }] },
    ],
};
const getCatalog = vi.fn(async () => CATALOG);
const listAutomations = vi.fn(async () => ({ automations: [] }));
vi.mock('../../hooks/useAutomationApi', () => ({
    default: () => ({ getCatalog, listAutomations }),
}));

import WebpageAppsPanel from './WebpageAppsPanel';

const GRANTS = {
    integrations: [
        { tool: 'gmail_search', label: null, hasFixedArgs: true, integrationLabel: 'Gmail', available: true },
        { tool: 'slack_post', label: 'Team ping', hasFixedArgs: false, integrationLabel: 'Slack', available: false },
        { tool: 'sheets_append', label: 'Row', hasFixedArgs: false, integrationLabel: null, available: null },
    ],
    automations: [{ automationId: 'auto-1', label: 'Nightly sync' }],
    discoveryFailed: false,
};

beforeEach(() => {
    authFetch.mockReset();
    getCatalog.mockClear();
    listAutomations.mockClear();
    authFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => GRANTS }));
});

describe('WebpageAppsPanel — i18n', () => {
    it('BIJT — de drie statussen van een koppeling dragen elk een eigen sleutel', async () => {
        render(<WebpageAppsPanel webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.apps.status_connected⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.status_reconnect⟧')).toBeInTheDocument();
        // `null` is niet `false`: "weet ik niet" is een eigen zin, geen
        // stilzwijgend "niet verbonden".
        expect(screen.getByText('⟦webpages.apps.status_unknown⟧')).toBeInTheDocument();
    });

    it('BIJT — de kop, de ondertitel en de twee sectiekoppen komen uit het woordenboek', async () => {
        render(<WebpageAppsPanel webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.apps.title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.subtitle⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.section_apps⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.section_routines⟧')).toBeInTheDocument();
    });

    it('BIJT — "Verwijder X" reist met de naam als PARAMETER, niet als aangeplakte tekst', async () => {
        render(<WebpageAppsPanel webpageId="wp1" />);

        // Dezelfde sleutel als de verwijderknop in BuildBar: identieke Engelse
        // tekst, identieke parameter, identiek doel. Een tweede sleutel zou een
        // vertaler twee keer "Remove {name}" zonder context aanbieden en twee
        // identieke knoppen in hetzelfde product uit elkaar laten lopen.
        expect(await screen.findByLabelText('⟦webpages.build.remove_source⟧(name=gmail_search)')).toBeInTheDocument();
        expect(screen.getByLabelText('⟦webpages.build.remove_source⟧(name=Nightly sync)')).toBeInTheDocument();
    });

    it('BIJT — een niet-verbonden app in de keuzelijst is één zin met {name}, geen naam + Engels staartje', async () => {
        render(<WebpageAppsPanel webpageId="wp1" />);
        fireEvent.click(await screen.findByRole('button', { name: /webpages\.apps\.add_app/ }));

        const select = await screen.findByLabelText('⟦webpages.apps.field_app⟧');
        const option = [...select.options].find(o => o.value === 'youtrack');
        expect(option.textContent).toBe('⟦webpages.apps.option_not_connected⟧(name=YouTrack)');
        expect(option.disabled).toBe(true);
        // De verbonden app houdt zijn eigen naam — die komt van de server en
        // is geen copy van dit scherm.
        expect([...select.options].find(o => o.value === 'gmail').textContent).toBe('Gmail');
    });

    it('BIJT — ONBEKEND is niet "niet verbonden": een app zonder status blijft kiesbaar', async () => {
        // available === null is de stand waar dit paneel zelf een banner voor
        // heeft ("Couldn't verify your connected apps") en waar de pil "Status
        // unknown" zegt. Hem uitzetten en er "not connected" bij schrijven
        // stuurt de auteur een koppeling maken die er misschien gewoon is —
        // en laat hem intussen niet kiezen.
        getCatalog.mockResolvedValueOnce({
            apps: [{ id: 'drive', label: 'Drive', available: null, actions: [{ name: 'drive_list', label: 'drive list' }] }],
        });
        render(<WebpageAppsPanel webpageId="wp1" />);
        fireEvent.click(await screen.findByRole('button', { name: /webpages\.apps\.add_app/ }));

        const select = await screen.findByLabelText('⟦webpages.apps.field_app⟧');
        const option = [...select.options].find(o => o.value === 'drive');
        expect(option.textContent).toBe('⟦webpages.apps.option_status_unknown⟧(name=Drive)');
        expect(option.disabled).toBe(false);

        fireEvent.change(select, { target: { value: 'drive' } });
        expect(await screen.findByTestId('app-status-unknown')).toBeInTheDocument();
        expect(screen.queryByText(/webpages\.apps\.app_not_connected/)).toBeNull();
    });

    it('BIJT — de lezer-zin voor niet-eigenaars is vertaalbaar', () => {
        render(<WebpageAppsPanel webpageId="wp1" readOnly />);

        expect(screen.getByText('⟦webpages.apps.owner_only⟧')).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });
});
