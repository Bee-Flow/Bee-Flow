import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De kop van Studio's Startscherm. Vijf dingen liggen hier vast:
 *
 *   1. het makersgetal komt van de SERVER (één telling), en de kop toont
 *      niets zolang het onbekend is;
 *   2. nul makers is een andere zin dan twaalf makers, en allebei iets anders
 *      dan "we weten het nog niet";
 *   3. "Bouwen met AI" is er echt: de kop draagt het beschrijf-paneel met
 *      dezelfde gegate secties, en de AI-regel van het "Nieuw"-menu landt
 *      daarop in plaats van op de Automations-terugval;
 *   4. de split-knop "Nieuw" staat in de kop en opent het menu uit het
 *      registry;
 *   5. de kop vraagt de aantallen één keer, zonder poller.
 */

const { fetchMock, countsSpy, aiPanelSpy } = vi.hoisted(() => ({
    fetchMock: vi.fn(), countsSpy: vi.fn(), aiPanelSpy: vi.fn(),
}));

// Het paneel zelf komt uit H4-P2 en heeft zijn eigen test; hier ligt alleen
// het CONTRACT vast — welke props deze kop eraan geeft, en dat de AI-regel van
// het menu erop landt. Gemockt, zodat die twee dingen bewezen blijven ook als
// het paneel eronder verandert (en zonder dat deze test het netwerk opgaat).
vi.mock('./studioAi/DescribeItPanel', async () => {
    const { createElement } = await import('react');
    return {
        default: (props) => {
            aiPanelSpy(props);
            return createElement(
                'div',
                { 'data-testid': 'studio-ai-panel', 'data-variant': props.variant },
                createElement('textarea', { 'data-testid': 'studio-ai-input', readOnly: true }),
            );
        },
    };
});

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: (...args) => fetchMock(...args) }));

// De echte hook, met een spion op de opties: het "één keer, geen poller"-punt
// hoort bij deze kop en wordt in useStudioCounts.test.js zelf uitgevoerd.
vi.mock('../../../hooks/useStudioCounts', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useStudioCounts: (opts) => { countsSpy(opts); return actual.useStudioCounts(opts); },
    };
});

vi.mock('../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let value = typeof fallback === 'string' ? fallback : key;
            const p = typeof fallback === 'string' ? params : fallback;
            if (p && typeof p === 'object') {
                for (const [k, v] of Object.entries(p)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
            return value;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

import { STUDIO_APPS, resolveStudioNav } from './studioApps';
import StudioHomeHeader from './StudioHomeHeader.jsx';
import { queryWrapper } from '../../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

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
        // Geen tweede poller op een scherm waarvan de rail al pollt.
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
        // De organisatienaam kent de client zelf; het getal niet.
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
        // De gestippelde "nog niet"-kaart is weg, badge en al: er staat iets
        // dat werkt, dus er valt niets meer te beloven.
        expect(screen.queryByTestId('studio-home-ai')).toBeNull();
        expect(screen.queryByTestId('studio-home-ai-badge')).toBeNull();
        expect(screen.queryByTestId('studio-home-ai-note')).toBeNull();
        expect(screen.getByTestId('studio-ai-panel').getAttribute('data-variant')).toBe('inline');
        // Dezelfde gegate secties en dezelfde navigatie als het "Nieuw"-menu
        // ernaast — anders kan het paneel een soort aanbieden die deze lezer
        // op de rail juist gelockt ziet.
        const props = aiPanelSpy.mock.calls.at(-1)[0];
        expect(props.sections).toBe(sections);
        expect(props.onNavigate).toBe(onNavigate);
        expect(props.user).toBe(ORG_USER);
    });

    it('de AI-regel van het "Nieuw"-menu landt op dat paneel, niet op de Automations-terugval', () => {
        // Zonder Automations-sectie zou de regel zonder eigen `onAi` GELOCKT zijn
        // (dat is de terugval in NewMenu.jsx). Dat hij hier open staat, niets
        // navigeert en de cursor in het paneel zet, bewijst dat de kop hem een
        // eigen bestemming geeft.
        const onNavigate = vi.fn();
        renderHeader({ sections: allOpen().filter((a) => a.id !== 'aiTasks'), onNavigate });
        fireEvent.click(screen.getByTestId('new-menu-chevron'));
        const ai = screen.getByTestId('new-menu-ai');
        expect(ai.hasAttribute('disabled')).toBe(false);
        fireEvent.click(ai);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId('studio-ai-input'));
        // Eén paneel op dit scherm, niet ook nog een dialoog ernaast.
        expect(screen.getAllByTestId('studio-ai-panel')).toHaveLength(1);
    });

    it('draagt de split-knop "Nieuw" en opent het menu uit het registry', () => {
        renderHeader();
        expect(screen.getByTestId('new-menu-trigger')).toBeTruthy();
        expect(screen.queryByTestId('new-menu')).toBeNull();
        fireEvent.click(screen.getByTestId('new-menu-chevron'));
        expect(screen.getByTestId('new-menu')).toBeTruthy();
        // Afgeleid uit dezelfde secties als de rest van het scherm.
        expect(screen.getByTestId('new-menu-aiTasks')).toBeTruthy();
    });

    it('een gelockte sectie staat in het menu als bordje, niet als deur', () => {
        const community = resolveStudioNav(STUDIO_APPS, {
            user: {}, hasLicenseFeature: (f) => f === 'automations', canUse: (id) => id === 'automations',
            hasPermission: () => true, can: () => false, lockReason: () => 'ceiling',
        }).filter((a) => !a.hiddenFromNav);
        renderHeader({ sections: community });
        fireEvent.click(screen.getByTestId('new-menu-chevron'));
        const locked = screen.getByTestId('new-menu-apps');
        expect(locked.getAttribute('data-locked')).toBe('true');
        expect(locked.getAttribute('aria-disabled')).toBe('true');
    });
});
