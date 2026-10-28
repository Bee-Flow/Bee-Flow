import { render as rtlRender, screen, cleanup, RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The header of Studio's start screen. Five things are pinned down here:
 *
 *   1. the makers number comes from the SERVER (one count), and the header shows
 *      nothing while it is unknown;
 *   2. zero makers is a different sentence from twelve makers, and both are
 *      different from “we do not know yet”;
 *   3. “Building with AI” really exists: the header carries the describe panel with
 *      the same gated sections, and the AI line of the “New” menu lands on it
 *      instead of on the Automations fallback;
 *   4. the split button “New” is in the header and opens the menu from the registry;
 *   5. the header asks for the numbers once, without a poller.
 */

const { fetchMock, countsSpy, aiPanelSpy } = vi.hoisted(() => ({
    fetchMock: vi.fn(), countsSpy: vi.fn(), aiPanelSpy: vi.fn(),
}));

// The panel itself comes from H4-P2 and has its own test; here only the CONTRACT
// is pinned — which props this header gives it, and that the AI line of the menu
// lands on it. Mocked, so that those two things remain proven even if the panel
// underneath changes (and without this test going out to the network).
vi.mock('./studioAi/DescribeItPanel', async () => {
    const { createElement } = await import('react');
    return {
        default: (props: Parameters<typeof aiPanelSpy>[0]) => {
            aiPanelSpy(props);
            return createElement(
                'div',
                { 'data-testid': 'studio-ai-panel', 'data-variant': props.variant },
                createElement('textarea', { 'data-testid': 'studio-ai-input', readOnly: true }),
            );
        },
    };
});

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: (...args: Parameters<typeof fetchMock>) => fetchMock(...args) }));

// The real hook, with a spy on the options: the “once, no poller” point belongs
// to this header and is run in useStudioCounts.test.js itself.
vi.mock('@/hooks/useStudioCounts', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        useStudioCounts: (opts: Parameters<typeof countsSpy>[0]) => { countsSpy(opts); return (actual.useStudioCounts as (o: unknown) => unknown)(opts); },
    };
});

vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

import { STUDIO_APPS, resolveStudioNav } from './studioApps';
import StudioHomeHeader from './StudioHomeHeader';
import { queryWrapper } from '@/test/queryWrapper';
import type { ReactElement } from 'react';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui: ReactElement, options?: RenderOptions<typeof import("@testing-library/dom/types/queries"),HTMLElement,HTMLElement>|undefined) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const allOpen = () => resolveStudioNav(STUDIO_APPS, {
    user: {}, hasLicenseFeature: () => true, canUse: () => true, hasPermission: () => true,
    can: () => true, lockReason: () => null,
}).filter((a) => !a.hiddenFromNav);

const ORG_USER = { id: 'u1', organization: { id: 'o1', name: 'Acme B.V.' } };

const renderHeader = (props = {}) => render(
    <StudioHomeHeader user={ORG_USER} sections={allOpen()} onNavigate={vi.fn()} {...props} />,
);

describe('StudioHomeHeader', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        countsSpy.mockReset();
        aiPanelSpy.mockReset();
        fetchMock.mockResolvedValue(ok({ counts: {}, makers: 12 }));
    });

    it('leest het makersgetal uit GET /api/studio/counts — één keer, zonder poller', async () => {
        renderHeader();
        expect(await screen.findByTestId('studio-home-makers')).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio/counts');
        // No second poller on a screen whose rail already polls.
        expect(countsSpy).toHaveBeenCalledWith({ enabled: true, poll: false });
    });

    it('"Organisatie X · 12 makers", met in de tooltip wat er geteld is', async () => {
        renderHeader();
        // The line is there at once; the number lands when the read does.
        await screen.findByTestId('studio-home-makers');
        const line = screen.getByTestId('studio-home-meta');
        expect(screen.getByTestId('studio-home-org').textContent).toBe('Acme B.V.');
        expect(line.textContent).toContain('Acme B.V. · 12 makers');
        expect(screen.getByTestId('studio-home-makers').getAttribute('title'))
            .toBe('Everyone who owns something you can see in Studio.');
    });

    it('enkelvoud en meervoud staan uit elkaar — nooit "1 makers"', async () => {
        fetchMock.mockResolvedValue(ok({ counts: {}, makers: 1 }));
        renderHeader();
        expect((await screen.findByTestId('studio-home-makers')).textContent).toBe('1 maker');
    });

    it('nul is een zin over ZICHT, geen getal: "0 makers" zou de lezer zelf wegtellen', async () => {
        fetchMock.mockResolvedValue(ok({ counts: {}, makers: 0 }));
        renderHeader();
        expect((await screen.findByTestId('studio-home-makers')).textContent).toBe('Nothing you can see here yet');
    });

    it('onbekend belooft niets: geen getal en geen nul zolang het antwoord er niet is', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        renderHeader();
        // The organisation name the client knows itself; the number it does not.
        expect(await screen.findByTestId('studio-home-org')).toBeTruthy();
        expect(screen.queryByTestId('studio-home-makers')).toBeNull();
    });

    it('zonder organisatie en zonder getal blijft er één zin staan', () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        renderHeader({ user: { id: 'u2' } });
        expect(screen.queryByTestId('studio-home-meta')).toBeNull();
        expect(screen.getByTestId('studio-home-desc').textContent).toBe('Everything you build, in one place');
    });

    it('draagt het beschrijf-paneel — geen plaatshouder meer, en dezelfde secties als de rest van de kop', () => {
        const sections = allOpen();
        const onNavigate = vi.fn();
        renderHeader({ sections, onNavigate });
        // The dotted “not yet” card is gone, badge and all: there is something that
        // works, so there is nothing left to promise.
        expect(screen.queryByTestId('studio-home-ai')).toBeNull();
        expect(screen.queryByTestId('studio-home-ai-badge')).toBeNull();
        expect(screen.queryByTestId('studio-home-ai-note')).toBeNull();
        expect(screen.getByTestId('studio-ai-panel').getAttribute('data-variant')).toBe('inline');
        // The same gated sections and the same navigation as the “New” menu next to it —
        // otherwise the panel could offer a kind that this reader sees locked on the rail.
        const props = aiPanelSpy.mock.calls.at(-1)![0];
        expect(props.sections).toBe(sections);
        expect(props.onNavigate).toBe(onNavigate);
        expect(props.user).toBe(ORG_USER);
    });

    it('de AI-regel van het "Nieuw"-menu landt op dat paneel, niet op de Automations-terugval', async () => {
        const user = userEvent.setup();
        // Without an Automations section the line would be LOCKED without its own `onAi`
        // (that is the fallback in NewMenu.jsx). That it is open here, that nothing
        // navigates and that the cursor is placed in the panel, proves that the header
        // gives it its own destination.
        const onNavigate = vi.fn();
        renderHeader({ sections: allOpen().filter((a) => a.id !== 'aiTasks'), onNavigate });
        await user.click(screen.getByTestId('new-menu-chevron'));
        const ai = screen.getByTestId('new-menu-ai');
        expect(ai.hasAttribute('disabled')).toBe(false);
        await user.click(ai);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId('studio-ai-input'));
        // One panel on this screen, not also another dialog next to it.
        expect(screen.getAllByTestId('studio-ai-panel')).toHaveLength(1);
    });

    it('draagt de split-knop "Nieuw" en opent het menu uit het registry', async () => {
        const user = userEvent.setup();
        renderHeader();
        expect(screen.getByTestId('new-menu-trigger')).toBeTruthy();
        expect(screen.queryByTestId('new-menu')).toBeNull();
        await user.click(screen.getByTestId('new-menu-chevron'));
        expect(screen.getByTestId('new-menu')).toBeTruthy();
        // Afgeleid uit dezelfde secties als de rest van het scherm.
        expect(screen.getByTestId('new-menu-aiTasks')).toBeTruthy();
    });

    it('een gelockte sectie staat in het menu als bordje, niet als deur', async () => {
        const user = userEvent.setup();
        const community = resolveStudioNav(STUDIO_APPS, {
            user: {}, hasLicenseFeature: (f) => f === 'automations', canUse: (id) => id === 'automations',
            hasPermission: () => true, can: () => false, lockReason: () => 'ceiling',
        }).filter((a) => !a.hiddenFromNav);
        renderHeader({ sections: community });
        await user.click(screen.getByTestId('new-menu-chevron'));
        const locked = screen.getByTestId('new-menu-apps');
        expect(locked.getAttribute('data-locked')).toBe('true');
        expect(locked.getAttribute('aria-disabled')).toBe('true');
    });
});
