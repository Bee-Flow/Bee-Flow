import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import ThemeContext from '../../components/appearance/ThemeContext';
import { withQueryClient } from '@/test/render';
import AppearanceSection from './AppearanceSection';

/**
 * Settings → Appearance. Pinned: the page title is the same h2 every settings
 * page uses, in both the open and the locked state, a preset pick goes to the
 * user override, and the icon pack a person uses is chosen here (it moved out
 * of the whole-server Appearance page), only once they have a pack.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let packs: Array<{ id: string; name: string; icons?: Record<string, unknown> }> = [];
let fetchSpy: MockInstance<typeof fetch>;
const activations = () => fetchSpy.mock.calls.filter(c => String(c[0]).includes('/activate'));

beforeEach(() => {
    packs = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
        String(url).includes('/activate') ? json({ success: true }) : json({ packs, activeIconPackId: null, categories: [] })
    ));
});
afterEach(() => { fetchSpy.mockRestore(); });

function renderWith(theme: Record<string, unknown>) {
    return render(withQueryClient(
        <ThemeContext.Provider value={theme as never}>
            <AppearanceSection />
        </ThemeContext.Provider>,
    ));
}

describe('AppearanceSection', () => {
    it('names the page with an h2 and offers the theme presets', async () => {
        const setUserOverride = vi.fn().mockResolvedValue(undefined);
        renderWith({ allowUserOverride: true, preset: 'dark', setUserOverride });

        expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
        expect(screen.getByText('Customise how Bee Flow looks on this device. Only you see your choice.')).toBeInTheDocument();

        await userEvent.setup().click(screen.getByRole('button', { name: /Light/ }));
        expect(setUserOverride).toHaveBeenCalledWith({ preset: 'light' });
    });

    it('keeps the same title when the organisation locked the appearance', () => {
        renderWith({ allowUserOverride: false, preset: 'paper' });

        expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
        expect(screen.getByText('Paper')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Light/ })).toBeNull();
    });

    it('shows no icon-pack choice while the person has no pack of their own', async () => {
        renderWith({ allowUserOverride: true, preset: 'dark', setUserOverride: vi.fn() });
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(screen.queryByRole('radiogroup', { name: 'Icon pack' })).toBeNull();
    });

    it('lets the person pick the icon pack they use, also when the theme is locked', async () => {
        packs = [{ id: 'p1', name: 'Line icons', icons: { 'tools.search': {} } }];
        const user = userEvent.setup();
        renderWith({ allowUserOverride: false, preset: 'paper' });

        const group = await screen.findByRole('radiogroup', { name: 'Icon pack' });
        expect(group).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /Standard icons/ })).toHaveAttribute('aria-checked', 'true');

        await user.click(screen.getByRole('radio', { name: /Line icons/ }));
        await waitFor(() => expect(activations().length).toBeGreaterThan(0));
        expect(String(activations()[0][0])).toContain('/api/icons/p1/activate');
        expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    });
});
