import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APPS-13 — every user-visible string on /app/apps goes through t().
 *
 * The other AppsHomePage suite mocks t() as an IDENTITY translator (the second
 * argument, the English fallback, comes back out). That is the right stub for
 * asserting behaviour, but it cannot tell a translated string apart from a
 * hardcoded one: both render the same English.
 *
 * So this suite installs a translator that ECHOES THE KEY and throws the
 * fallback away. Under it, anything that reached the screen through t() reads
 * as «some.key», and anything that did not still reads as English. Asserting
 * the English is *absent* is what makes the test bite: paste a literal back
 * into the JSX and it reappears.
 *
 * WHAT THIS SUITE CANNOT TELL YOU — read this before signing APPS-13 off.
 * An echoing translator answers every key, including keys that exist nowhere.
 * So a green run here proves the string is ROUTED through t(); it proves
 * nothing about whether the key has a translation to route TO. The assertions
 * below name keys (apps.published_count_plural among them) that are, at the
 * time of writing, in neither en-defaults.js nor server/i18n/defaults/en.js —
 * so the page renders its English fallback for every reader, in every locale,
 * and the Languages panel has no row to change.
 *
 * The check that DOES see that is src/i18n/i18nGuard.test.js, and it is red on
 * 25 apps.* keys plus the nOf pair apps.published_count(+_plural). Minting
 * them means editing both dictionaries, which is outside the fence of every
 * stage that produced this page: it is handed to the integrating session as
 * work, not as a finished feature. Green here + red there is the expected
 * state until that lands — never read this suite as the whole of APPS-13.
 */
const echoT = (key) => `«${key}»`;
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
}));

// The licence gates behind the Studio button. Shut by default — every test
// here renders for a plain reader — and opened by the one test that checks
// that button's string.
const gate = { open: false };
vi.mock('../../components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => gate.open }),
}));
vi.mock('../../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ can: () => gate.open }),
}));

vi.mock('../../components/admin/Studio/AppStudio/studioAppsApi', () => {
    const studioAppsApi = { listAccessible: vi.fn(), listMine: vi.fn() };
    return { default: studioAppsApi, studioAppsApi };
});

import AppsHomePage from './AppsHomePage';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import scopedStorage from '../../utils/scopedStorage';

beforeEach(() => {
    vi.clearAllMocks();
    gate.open = false;
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
    localStorage.clear();
    scopedStorage.setCurrentUser(null);
});

describe('AppsHomePage i18n', () => {
    it('translates the page heading', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: 'CRM Pipeline', isPublished: true }],
        });
        render(<AppsHomePage />);

        await screen.findByText('CRM Pipeline');
        expect(screen.getByRole('heading', { name: '«apps.title»' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Apps' })).not.toBeInTheDocument();
    });

    it('translates the empty state, title and description alike', async () => {
        render(<AppsHomePage />);

        expect(await screen.findByText('«apps.empty_title»')).toBeInTheDocument();
        expect(screen.getByText('«apps.empty_description»')).toBeInTheDocument();
        expect(screen.queryByText('No apps yet')).not.toBeInTheDocument();
        expect(screen.queryByText(/No apps have been shared with you yet/i)).not.toBeInTheDocument();
    });

    it('translates the card chrome — the hover "Open" label and the nameless-app placeholder', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [{ id: 'a1', name: '', isPublished: true }],
        });
        render(<AppsHomePage />);

        const card = await screen.findByRole('link');
        expect(within(card).getByText('«apps.untitled»')).toBeInTheDocument();
        expect(within(card).getByText('«apps.open»')).toBeInTheDocument();
        expect(card.textContent).not.toMatch(/Untitled app/);
        expect(card.textContent).not.toMatch(/\bOpen\b/);
    });

    it('translates the category pill row, labels and its group name alike', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'CRM Pipeline', isPublished: true, category: 'sales' },
                { id: 'a2', name: 'Ledger', isPublished: true, category: 'finance' },
            ],
        });
        render(<AppsHomePage />);

        const group = await screen.findByRole('group', { name: '«apps.filter_by_category»' });
        expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
            '«apps.category.all»', '«apps.category.sales»', '«apps.category.finance»',
        ]);
    });

    it('leaves no untranslated English anywhere on a fully populated directory', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'CRM Pipeline', description: 'Track deals', isPublished: true, category: 'sales' },
                { id: 'a2', name: '', isPublished: true },
            ],
        });
        const { container } = render(<AppsHomePage />);
        await screen.findByText('CRM Pipeline');

        // App names and descriptions are DATA — they stay as the builder typed
        // them. Everything the page says in its own voice must be a key.
        const chrome = container.textContent
            .replace('CRM Pipeline', '')
            .replace('Track deals', '');
        for (const english of ['Apps', 'Open', 'Untitled app', 'All', 'Sales', 'Retry', 'No apps yet']) {
            expect(chrome).not.toContain(english);
        }
    });
});

// The strip the reader sees when the directory could not be fetched, and the
// skeleton they see while it still is being.
describe('AppsHomePage i18n — failure and loading states', () => {
    it('translates the error strip’s Retry button', async () => {
        studioAppsApi.listAccessible.mockRejectedValue(new Error('boom'));
        render(<AppsHomePage />);

        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText('«apps.retry»')).toBeInTheDocument();
        expect(within(alert).queryByText('Retry')).not.toBeInTheDocument();
    });

    it('shows the failure’s own message verbatim — that text has no key', async () => {
        studioAppsApi.listAccessible.mockRejectedValue(new Error('the server said no'));
        render(<AppsHomePage />);

        const alert = await screen.findByRole('alert');
        // A message the server chose is not ours to translate; only the
        // generic "it broke and said nothing" case has a key.
        expect(within(alert).getByText(/the server said no/)).toBeInTheDocument();
        expect(within(alert).queryByText('«apps.load_failed»')).not.toBeInTheDocument();
    });

    it('translates the generic failure when the error carried no message', async () => {
        studioAppsApi.listAccessible.mockRejectedValue(new Error(''));
        render(<AppsHomePage />);

        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText('«apps.load_failed»')).toBeInTheDocument();
        expect(alert.textContent).not.toMatch(/Could not load your apps/i);
        // Never the raw marker itself.
        expect(alert.textContent).not.toMatch(/Symbol\(/);
    });

    it('translates the loading skeleton’s accessible name and its screen-reader line', () => {
        // Synchronous: the directory is still fetching on this first paint.
        render(<AppsHomePage />);

        expect(screen.getByRole('status', { name: '«apps.loading»' })).toBeInTheDocument();
        expect(screen.getByText('«apps.loading_short»')).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: 'Loading apps' })).not.toBeInTheDocument();
    });
});

// The chrome added on top of the grid: header, search, footer, footnote.
describe('AppsHomePage i18n — the chrome around the grid', () => {
    const app = (id, extra = {}) => ({ id, name: `App ${id}`, isPublished: true, ...extra });

    it('translates the header: the counted pill and the Studio button', async () => {
        gate.open = true;
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1'), app('a2')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        const bar = within(screen.getByTestId('apps-toolbar'));
        expect(bar.getByText('«apps.published_count_plural»')).toBeInTheDocument();
        expect(bar.getByText('«apps.build_in_studio»')).toBeInTheDocument();
        expect(screen.queryByText(/\d+ published/)).not.toBeInTheDocument();
        expect(screen.queryByText('Build in Studio')).not.toBeInTheDocument();
    });

    it('picks the SINGULAR key for one app — the form is a key choice, not a string one', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        expect(screen.getByText('«apps.published_count»')).toBeInTheDocument();
        expect(screen.queryByText('«apps.published_count_plural»')).not.toBeInTheDocument();
    });

    it('translates the search box — placeholder and accessible name alike', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        // An attribute is exactly where a hardcoded string hides longest: it
        // never shows up in a textContent sweep.
        const box = screen.getByRole('searchbox', { name: '«apps.search_placeholder»' });
        expect(box).toHaveAttribute('placeholder', '«apps.search_placeholder»');
    });

    it('translates the no-match line', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });

        expect(screen.getByText('«apps.no_matches»')).toBeInTheDocument();
        expect(screen.queryByText(/No apps match/i)).not.toBeInTheDocument();
    });

    it('translates the order line, the access hint and the footnote', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1'), app('a2')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        expect(screen.getByText('«apps.sorted_by_name»')).toBeInTheDocument();
        expect(screen.getByText('«apps.access_hint»')).toBeInTheDocument();
        expect(screen.getByText('«apps.footnote»')).toBeInTheDocument();
    });

    it('translates the card footer: the category and the "new" badge', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [app('a1', { category: 'sales', publishedAt: new Date().toISOString() })],
        });
        render(<AppsHomePage />);
        const card = await screen.findByRole('link', { name: /App a1/ });

        expect(within(card).getByText('«apps.category.sales»')).toBeInTheDocument();
        expect(within(card).getByText('«apps.new_badge»')).toBeInTheDocument();
        expect(card.textContent).not.toMatch(/\bnew\b/);
    });
});
