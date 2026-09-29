import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Studio's front door. It exists because `/app/studio` now resolves to the
 * `start` section, and a section the shell cannot render is a white pane — so
 * the two things worth pinning are that it renders the same gated sections
 * the rail does, and that a locked one is a signpost rather than a door.
 */

const { licenseMock, entitlementsMock, attentionRun, recentRun, authFetchMock, aiPanelSpy } = vi.hoisted(() => ({
    licenseMock: { hasFeature: () => true },
    entitlementsMock: { can: () => true, lockReason: () => null, loading: false, error: null },
    attentionRun: vi.fn(),
    recentRun: vi.fn(),
    authFetchMock: vi.fn(),
    aiPanelSpy: vi.fn(),
}));

// Het beschrijf-paneel praat met POST /api/studio/ai/route en heeft zijn eigen
// test; hier telt alleen dat dit scherm het draagt en waarmee het het voedt.
vi.mock('./studioAi/DescribeItPanel', async () => {
    const { createElement } = await import('react');
    return {
        default: (props) => {
            aiPanelSpy(props);
            return createElement('div', { 'data-testid': 'studio-ai-panel', 'data-variant': props.variant });
        },
    };
});

// The one thing on this screen that goes to the network. Stubbed here so the
// screen's own assertions do not depend on three endpoints; the list itself is
// tested in attention/AttentionList.test.jsx.
vi.mock('./attention/attentionChecks', async (importOriginal) => ({
    ...(await importOriginal()),
    runAttentionChecks: (...args) => attentionRun(...args),
}));

// "Laatst bewerkt" haalt tot negen lijsten op; hier afgevangen, want de regels
// eromheen staan in recent/recentWork.test.js en recent/RecentWorkList.test.jsx.
vi.mock('./recent/recentWork', async (importOriginal) => ({
    ...(await importOriginal()),
    runRecentWork: (...args) => recentRun(...args),
}));

// De kaart onderaan leest GET /api/studio/counts één keer bij het monteren.
// Hier alleen afgevangen: haar eigen gedrag staat in map/StudioMap.test.jsx.
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetchMock(...args),
}));

vi.mock('../../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => fallback || key, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('../../../moduleRuntime/registry', () => ({ useRuntimeStudioApps: () => [] }));
vi.mock('../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: (f) => licenseMock.hasFeature(f), deploymentMode: 'cloud' }),
}));
vi.mock('../../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({
        can: (id) => entitlementsMock.can(id),
        lockReason: (id) => entitlementsMock.lockReason(id),
        loading: entitlementsMock.loading,
        error: entitlementsMock.error,
    }),
}));

import StudioStart from './StudioStart.jsx';
import { queryWrapper } from '../../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const renderStart = (props = {}) => render(
    <StudioStart user={{ permissions: ['all'] }} hasPermission={() => true} onNavigate={vi.fn()} {...props} />
);

describe('StudioStart', () => {
    beforeEach(() => {
        cleanup();
        licenseMock.hasFeature = () => true;
        entitlementsMock.can = () => true;
        entitlementsMock.lockReason = () => null;
        entitlementsMock.loading = false;
        entitlementsMock.error = null;
        attentionRun.mockReset();
        attentionRun.mockResolvedValue({ findings: [], unavailable: [], complete: true, checked: [], skipped: [] });
        recentRun.mockReset();
        recentRun.mockResolvedValue({ items: [], unavailable: [], skipped: [], complete: true });
        authFetchMock.mockReset();
        aiPanelSpy.mockReset();
        authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ counts: {}, makers: 0 }) });
    });

    it('renders the sections it can open, grouped, and opens one', () => {
        const onNavigate = vi.fn();
        renderStart({ onNavigate });
        expect(screen.getByTestId('studio-start')).toBeTruthy();
        // Approvals is hiddenFromNav — it has its own top-level sidebar row.
        expect(screen.queryByTestId('studio-start-approvals')).toBeNull();
        fireEvent.click(screen.getByTestId('studio-start-skills'));
        expect(onNavigate).toHaveBeenCalledWith('studio/skills');
    });

    it('carries the "needs attention" list, asked with this screen\'s own gate context', async () => {
        renderStart({ user: { id: 'u1', permissions: ['all'] } });
        expect(await screen.findByTestId('studio-attention')).toBeTruthy();
        const ctx = attentionRun.mock.calls[0][0];
        expect(ctx.user).toMatchObject({ id: 'u1' });
        // The licence answer the rest of the screen gates on, not a second one.
        expect(ctx.hasFeature('projects')).toBe(true);
    });

    it('draagt de kop: het makersgetal van de server, en de split-knop "Nieuw"', async () => {
        renderStart();
        expect(screen.getByTestId('studio-home-header')).toBeTruthy();
        expect(screen.getByTestId('new-menu-trigger')).toBeTruthy();
        expect((await screen.findByTestId('studio-home-makers')).textContent).toBe('Nothing you can see here yet');
        // Geteld op de server, niet uit de lijsten op dit scherm afgeleid.
        expect(authFetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/studio/counts'))).toBe(true);
    });

    it('draagt "Beschrijf wat je wilt" — één paneel, met dezelfde gegate secties als de rest van het scherm', () => {
        renderStart();
        // De plaatshouder uit H3 is weg; er staat één echt paneel.
        expect(screen.queryByTestId('studio-home-ai')).toBeNull();
        expect(screen.getAllByTestId('studio-ai-panel')).toHaveLength(1);
        const asked = aiPanelSpy.mock.calls.at(-1)[0].sections.map((a) => a.id);
        // Dezelfde rijen als de sectiekaartjes en "Laatst bewerkt": gegate, en
        // zonder de secties die hun eigen ingang hebben.
        expect(asked).toContain('skills');
        expect(asked).not.toContain('approvals');

        // En met een Community-org reist de LOCK mee, zodat het paneel geen
        // soort kan aanbieden die dit scherm er zelf als bordje neerzet.
        cleanup();
        aiPanelSpy.mockReset();
        entitlementsMock.can = () => false;
        entitlementsMock.lockReason = () => 'ceiling';
        renderStart();
        const locked = aiPanelSpy.mock.calls.at(-1)[0].sections.find((a) => a.id === 'skills');
        expect(locked.locked).toBe('ceiling');
    });

    it('draagt "Laatst bewerkt", gevraagd met dezelfde gegate secties', async () => {
        renderStart();
        expect(await screen.findByTestId('studio-recent')).toBeTruthy();
        const asked = recentRun.mock.calls[0][0];
        // Dezelfde rijen als de sectiekaartjes eronder: gegate, en zonder de
        // secties die hun eigen ingang hebben.
        expect(asked.map((a) => a.id)).toContain('skills');
        expect(asked.map((a) => a.id)).not.toContain('approvals');
    });

    it('carries the map of building blocks, with its connections in words', () => {
        renderStart();
        expect(screen.getByTestId('studio-map')).toBeTruthy();
        // De plaat is niet de informatie: de zinnen staan er los van.
        expect(screen.getByTestId('studio-map-sentence-form-triggers-automation')).toBeTruthy();
    });

    it('shows a licence-locked section as a signpost, not a door', () => {
        // A Community org: the capability gates fail and the plan does not
        // include them, so the rows stay visible with an upgrade hint.
        entitlementsMock.can = () => false;
        entitlementsMock.lockReason = () => 'ceiling';
        const onNavigate = vi.fn();
        renderStart({ onNavigate });
        const locked = screen.getByTestId('studio-start-skills');
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByTestId('studio-start-skills-lock-hint').textContent).toBeTruthy();
        fireEvent.click(locked);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('does not flash "upgrade" while the entitlements are still loading', () => {
        // `can` answers false for everything during the load, so a lockReason
        // consulted now would call every gated section 'ceiling'. Until the
        // answer is real a failed gate hides the row, as it always did.
        entitlementsMock.can = () => false;
        entitlementsMock.lockReason = () => 'ceiling';
        entitlementsMock.loading = true;
        renderStart();
        expect(screen.queryByTestId('studio-start-skills')).toBeNull();
        expect(screen.queryByTestId('studio-start-skills-lock-hint')).toBeNull();
    });

    it('leest de aantallen ÉÉN keer voor het hele scherm', async () => {
        renderStart();
        await screen.findByTestId('studio-attention');
        const countCalls = authFetchMock.mock.calls.filter(([url]) => url.includes('/api/studio/counts'));
        // Twee lezingen op één scherm zijn niet alleen een verzoek te veel:
        // ze kunnen uiteenlopen, en dan staat er een makersgetal uit een
        // antwoord dat de kaart tegelijk "niet gelezen" noemt.
        expect(countCalls).toHaveLength(1);
    });

    it('belooft "Laatst bewerkt" niets zolang de poorten geen antwoord hebben', async () => {
        // Met een entitlements-fout LAAT resolveStudioNav de zeven gegate
        // secties helemaal weg — ze staan dan noch in `unavailable` noch in
        // `skipped`, en zonder deze vlag print het scherm "Nothing edited yet"
        // over zeven lijsten die nooit gevraagd zijn.
        entitlementsMock.error = new Error('entitlements down');
        entitlementsMock.can = () => false;
        renderStart();
        await screen.findByTestId('studio-attention');
        expect(recentRun.mock.calls[0][1]).toMatchObject({ gatesResolved: false });
    });

    it('en wél zodra de poorten een echt antwoord gaven', async () => {
        renderStart();
        await screen.findByTestId('studio-attention');
        expect(recentRun.mock.calls[0][1]).toMatchObject({ gatesResolved: true });
    });
});
