import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageAppsPanel — the second heaviest (57 literal strings).
 *
 * t() is a MARKER (`⟦key⟧`). What is fixed here is not only THAT it is translated, but also HOW: a name that stands in a sentence travels as a parameter, not as a separate piece of English stuck to the name. That form is the difference between a translatable sentence and half of one.
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
        // `null` is not `false`: "don't know" is a sentence of its own, not a silent
        // "not connected".
        expect(screen.getByText('⟦webpages.apps.status_unknown⟧')).toBeInTheDocument();
    });

    it('BIJT — de kop, de ondertitel en de twee sectiekoppen komen uit het woordenboek', async () => {
        render(<WebpageAppsPanel webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.apps.title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.subtitle⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.section_apps⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.apps.section_automations⟧')).toBeInTheDocument();
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
        const user = userEvent.setup();
        render(<WebpageAppsPanel webpageId="wp1" />);
        await user.click(await screen.findByRole('button', { name: /webpages\.apps\.add_app/ }));

        const select = await screen.findByLabelText('⟦webpages.apps.field_app⟧');
        const option = [...select.options].find(o => o.value === 'youtrack');
        expect(option.textContent).toBe('⟦webpages.apps.option_not_connected⟧(name=YouTrack)');
        expect(option.disabled).toBe(true);
        // The connected app keeps its own name — that comes from the server and is not
        // a copy of this screen.
        expect([...select.options].find(o => o.value === 'gmail').textContent).toBe('Gmail');
    });

    it('BIJT — ONBEKEND is niet "niet verbonden": een app zonder status blijft kiesbaar', async () => {
        const user = userEvent.setup();
        // available === null is the state for which this panel itself has a banner
        // ("Couldn't verify your connected apps") and where the pill says "Status
        // unknown". Switching it off and writing "not connected" beside it tells the
        // author to create a connection that may well simply exist — and meanwhile
        // does not let him choose it.
        getCatalog.mockResolvedValueOnce({
            apps: [{ id: 'drive', label: 'Drive', available: null, actions: [{ name: 'drive_list', label: 'drive list' }] }],
        });
        render(<WebpageAppsPanel webpageId="wp1" />);
        await user.click(await screen.findByRole('button', { name: /webpages\.apps\.add_app/ }));

        const select = await screen.findByLabelText('⟦webpages.apps.field_app⟧');
        const option = [...select.options].find(o => o.value === 'drive');
        expect(option.textContent).toBe('⟦webpages.apps.option_status_unknown⟧(name=Drive)');
        expect(option.disabled).toBe(false);

        await user.selectOptions(select, 'drive');
        expect(await screen.findByTestId('app-status-unknown')).toBeInTheDocument();
        expect(screen.queryByText(/webpages\.apps\.app_not_connected/)).toBeNull();
    });

    it('BIJT — de lezer-zin voor niet-eigenaars is vertaalbaar', () => {
        render(<WebpageAppsPanel webpageId="wp1" readOnly />);

        expect(screen.getByText('⟦webpages.apps.owner_only⟧')).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });
});
