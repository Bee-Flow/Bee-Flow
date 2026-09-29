import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chrome around the grid: the 48px header (APPS-14), the counted pill
 * (APPS-02), the way to the build side (APPS-03) and the failure strip's
 * colours (APPS-14 again).
 *
 * Two reasons this suite is not in AppsHomePage.test.jsx. The shared
 * translator stub does NOT interpolate, so "{count} published" would never
 * become "3 published" under it — and a counted pill is precisely the thing
 * that has to. And the Studio button hangs off two licensing contexts that
 * this file mocks per test; the other suite must keep rendering as it does
 * for a reader with no provider above the page at all.
 */
const t = (key, fallbackOrParams, paramsArg) => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    const value = hasFallback ? fallbackOrParams : key;
    return String(value).replace(
        /\{(\w+)\}/g,
        (whole, name) => (params && name in params ? String(params[name]) : whole),
    );
};
const translation = { t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} };
vi.mock('../../hooks/useTranslation', () => ({
    default: () => translation,
    useTranslation: () => translation,
    TranslationProvider: ({ children }) => children,
}));

// The two gates behind "Build in Studio", flipped per test.
const gate = { licence: false, capability: false };
vi.mock('../../components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: (id) => gate.licence && id === 'app_studio' }),
}));
vi.mock('../../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ can: (id) => gate.capability && id === 'app_studio' }),
}));

vi.mock('../../components/admin/Studio/AppStudio/studioAppsApi', () => {
    const studioAppsApi = { listAccessible: vi.fn(), listMine: vi.fn() };
    return { default: studioAppsApi, studioAppsApi };
});

import AppsHomePage from './AppsHomePage';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import scopedStorage from '../../utils/scopedStorage';

const app = (id, extra = {}) => ({ id, name: `App ${id}`, isPublished: true, ...extra });

beforeEach(() => {
    vi.clearAllMocks();
    gate.licence = false;
    gate.capability = false;
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
    localStorage.clear();
    scopedStorage.setCurrentUser(null);
});

describe('AppsHomePage header', () => {
    it('is pinned to the 48px header height every screen keeps', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        // jsdom loads no CSS, so nothing here can MEASURE 48px. What it can
        // do is refuse the failure this test is for: a second height class
        // sitting next to the first, where "contains h-12" would still pass
        // and the header would be whatever the later class says.
        const heights = (screen.getByTestId('apps-toolbar').className.match(/(^|\s)h-\S+/g) || [])
            .map((c) => c.trim());
        expect(heights).toEqual(['h-12']);
    });

    it('wears the app kind’s own mark — as a token, never as the value behind it', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        const bar = screen.getByTestId('apps-toolbar');
        const mark = bar.querySelector('[style*="--kind-app"]');
        // An app is violet everywhere in the product; this page must say so
        // in the one vocabulary index.css owns, not in the generic accent it
        // used to borrow and not by spelling the colour out.
        expect(mark, 'the header mark should take its colour from --kind-app').not.toBeNull();
        expect(mark.getAttribute('style')).toContain('var(--kind-app)');
        expect(mark.getAttribute('style')).not.toContain('--accent-primary');
        // Checked as "no raw colour value in the header", not as a list of
        // the two hexes that were once removed: the next hardcoded colour
        // will be a different one.
        expect(bar.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(bar.innerHTML).not.toMatch(/\brgba?\(/);
    });

    it('counts the apps in the directory next to the title', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1'), app('a2'), app('a3')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        expect(screen.getByText('3 published')).toBeInTheDocument();
    });

    it('keeps counting the whole directory while a chip narrows the grid', async () => {
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [app('a1', { category: 'sales' }), app('a2'), app('a3')],
        });
        render(<AppsHomePage />);
        await screen.findByText('App a1');

        fireEvent.click(screen.getByRole('button', { name: 'Sales' }));

        // The pill answers "how many apps may I open", which a filter does
        // not change. The grid below already shows what the chip did.
        expect(screen.getByText('3 published')).toBeInTheDocument();
    });

    it('counts nothing when there is nothing to count', async () => {
        render(<AppsHomePage />);
        await screen.findByText(/No apps have been shared with you yet/i);
        expect(screen.queryByText(/published/)).not.toBeInTheDocument();
    });
});

describe('AppsHomePage — the way to the build side', () => {
    const renderWith = async (licence, capability) => {
        gate.licence = licence;
        gate.capability = capability;
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [app('a1')] });
        render(<AppsHomePage />);
        await screen.findByText('App a1');
    };
    const button = () => screen.queryByRole('link', { name: 'Build in Studio' });

    it('offers the button to a reader who may build', async () => {
        await renderWith(true, true);
        expect(button()).toHaveAttribute('href', '/app/studio/apps');
    });

    it('needs the licence AND the capability, exactly like the sidebar row', async () => {
        await renderWith(true, false);
        expect(button()).not.toBeInTheDocument();
    });

    it('does not appear on the capability alone', async () => {
        await renderWith(false, true);
        expect(button()).not.toBeInTheDocument();
    });

    it('stays away for a reader who only uses apps', async () => {
        await renderWith(false, false);
        expect(button()).not.toBeInTheDocument();
    });
});

describe('AppsHomePage failure strip', () => {
    it('paints itself from the status tokens instead of two hard-coded reds', async () => {
        studioAppsApi.listAccessible.mockRejectedValue(new Error('boom'));
        render(<AppsHomePage />);
        const alert = await screen.findByRole('alert');

        const style = alert.getAttribute('style') || '';
        // The pairing index.css defines for every status chip: a tint of the
        // raw token for the field, the darker -ink for the words.
        expect(style).toContain('var(--error)');
        expect(style).toContain('var(--error-ink)');
        // Any raw colour, not the two reds that happened to be there before.
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(style).not.toMatch(/\brgba?\(/);
    });
});
