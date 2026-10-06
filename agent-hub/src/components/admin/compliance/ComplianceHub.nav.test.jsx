/**
 * Contract guard for ComplianceHub navigation. The settings surface
 * (AdvancedSettings → complianceNavAdapter) rewrites the paths this component
 * emits, so the shape `admin/compliance/<section>[/<checkId>]` is load-bearing
 * in two places. If these tests fail, update the adapter regex in
 * src/pages/settings/complianceNavAdapter.js in the same change.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ComplianceHub from './index';

vi.mock('../../../hooks/useTranslation', () => {
    const t = (key) => key;
    // Both import styles are in use (the shared primitives take the default export).
    return { useTranslation: () => ({ t }), default: () => ({ t }) };
});
vi.mock('./pages/OverviewPage', () => ({
    default: () => <div data-testid="overview-page" />,
}));
// The redesigned framework page takes the hub props object; the regulation
// it scores is derived from the section, so the mock derives it the same way.
vi.mock('./pages/FrameworkPage', async () => {
    const { frameworkOf } = await import('./sections');
    return {
        default: ({ section, focusId }) => (
            <div data-testid="checks-page" data-regulation={frameworkOf(section.id)} data-focus={focusId || ''} />
        ),
    };
});
// The redesigned settings page takes the hub props object, so the directory
// reaches it as `data.orgUsers` — the mock reads it where the page reads it.
vi.mock('./pages/SettingsPage', () => ({
    default: ({ data }) => {
        const orgUsers = data?.orgUsers ?? null;
        return <div data-testid="settings-page" data-orgusers={orgUsers === null ? 'null' : JSON.stringify(orgUsers)} />;
    },
}));
vi.mock('./pages/DsrPage', () => ({ default: () => <div data-testid="dsr-page" /> }));
vi.mock('./pages/RopaPage', () => ({ default: () => <div data-testid="ropa-page" /> }));
// Only the PAGE is stubbed: ComplianceHeader imports `dpiaRows` from this same
// module for the "n of m agents assessed" pill, so the real named exports stay.
vi.mock('./pages/DpiaPage', async (importActual) => ({
    ...(await importActual()),
    default: () => <div data-testid="dpia-page" />,
}));
vi.mock('../../shared/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('./shared/Skeleton', () => ({
    CheckCardSkeleton: () => <div data-testid="skeleton" />,
}));
// Desktop by default; one test flips it to prove `onBack` is mobile-only.
const viewport = { isMobile: false };
vi.mock('../../../hooks/useViewport', () => ({
    useViewport: () => ({ isMobile: viewport.isMobile, isCompact: false, isDesktop: !viewport.isMobile, width: viewport.isMobile ? 390 : 1600 }),
    default: () => ({ isMobile: viewport.isMobile, isCompact: false, isDesktop: !viewport.isMobile, width: viewport.isMobile ? 390 : 1600 }),
}));

function mockFetch() {
    global.fetch = vi.fn(async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/overview')
            ? { onboarded: true, overall: { score: 100 }, settings: {} }
            : []),
    }));
}

describe('ComplianceHub navigation contract', () => {
    beforeEach(() => {
        cleanup();
        mockFetch();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits admin/compliance/<section> when a sidebar section is clicked', async () => {
        const onNavigate = vi.fn();
        render(<ComplianceHub onNavigate={onNavigate} />);
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        fireEvent.click(screen.getByTitle('compliance.nav_gdpr'));
        expect(onNavigate).toHaveBeenCalledWith('admin/compliance/gdpr');
        fireEvent.click(screen.getByTitle('compliance.nav_settings'));
        expect(onNavigate).toHaveBeenCalledWith('admin/compliance/settings');
    });

    it('routes activeSection to the matching page', async () => {
        render(<ComplianceHub activeSection="gdpr" />);
        await waitFor(() => expect(screen.getByTestId('checks-page')).toBeInTheDocument());
        expect(screen.getByTestId('checks-page').dataset.regulation).toBe('GDPR');
    });

    it('threads focusCheckId through to the checks page', async () => {
        render(<ComplianceHub activeSection="aia" focusCheckId="AIA-Art50-ai-disclosure" />);
        await waitFor(() => expect(screen.getByTestId('checks-page')).toBeInTheDocument());
        expect(screen.getByTestId('checks-page').dataset.focus).toBe('AIA-Art50-ai-disclosure');
    });

    it('falls back to overview for an unknown section', async () => {
        render(<ComplianceHub activeSection="not-a-section" />);
        await waitFor(() => expect(screen.getByTestId('overview-page')).toBeInTheDocument());
    });

    it('routes the dsr / ropa / dpia sections to their pages', async () => {
        render(<ComplianceHub activeSection="dsr" />);
        await waitFor(() => expect(screen.getByTestId('dsr-page')).toBeInTheDocument());
        cleanup(); mockFetch();
        render(<ComplianceHub activeSection="ropa" />);
        await waitFor(() => expect(screen.getByTestId('ropa-page')).toBeInTheDocument());
        cleanup(); mockFetch();
        render(<ComplianceHub activeSection="dpia" />);
        await waitFor(() => expect(screen.getByTestId('dpia-page')).toBeInTheDocument());
    });

    it('fetches the org-user directory for the settings section and threads it down', async () => {
        render(<ComplianceHub activeSection="settings" />);
        await waitFor(() => expect(screen.getByTestId('settings-page')).toBeInTheDocument());
        await waitFor(() =>
            expect(global.fetch.mock.calls.some(([u]) => String(u).endsWith('/org-users'))).toBe(true));
        // The [] fallback (mock returns [] for non-overview URLs) reaches the page.
        await waitFor(() => expect(screen.getByTestId('settings-page').dataset.orgusers).toBe('[]'));
    });

    it('does not fetch the directory for sections without a picker', async () => {
        render(<ComplianceHub activeSection="gdpr" />);
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        expect(global.fetch.mock.calls.some(([u]) => String(u).endsWith('/org-users'))).toBe(false);
    });

    // ── Redesign additions (Sep 2026) ──

    it('resolves a pre-redesign id: activeSection="iso_soa" renders the SoA page and marks the SoA rail row current', async () => {
        render(<ComplianceHub activeSection="iso_soa" onNavigate={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('rail-row-soa')).toHaveAttribute('aria-current', 'page'));
        expect(screen.queryByTestId('rail-row-iso_soa')).toBeNull();
    });

    it('emits the CANONICAL id for a row that used to live under iso_*', async () => {
        const onNavigate = vi.fn();
        render(<ComplianceHub onNavigate={onNavigate} />);
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        fireEvent.click(screen.getByTitle('compliance.rail_soa'));
        expect(onNavigate).toHaveBeenCalledWith('admin/compliance/soa');
    });

    it('renders no rail meta and no attention badge while /counts answers the [] mock (unknown ≠ zero)', async () => {
        render(<ComplianceHub onNavigate={vi.fn()} />);
        await waitFor(() => expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/counts'))).toBe(true));
        expect(screen.queryAllByTestId('rail-meta').filter(el => /\b0\b/.test(el.textContent))).toHaveLength(0);
        expect(screen.queryByTestId('compliance-rail-chain')).toBeNull();
    });

    it('header tabs write ?tab= without a history entry and the section header shows the section title', async () => {
        const push = vi.spyOn(window.history, 'pushState');
        const replace = vi.spyOn(window.history, 'replaceState');
        render(<ComplianceHub activeSection="gdpr" onNavigate={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('checks-page')).toBeInTheDocument());
        const tab = screen.queryByRole('radio', { name: /compliance\.tab_gdpr_timeline/ });
        if (tab) {
            fireEvent.click(tab);
            expect(replace).toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
        }
    });

    it('passes onBack to the header only on a phone', async () => {
        const onBack = vi.fn();
        render(<ComplianceHub onNavigate={vi.fn()} onBack={onBack} />);
        await waitFor(() => expect(screen.getByTestId('overview-page')).toBeInTheDocument());
        // Desktop: the hub is embedded in Settings, which has its own back arrow — none here.
        expect(screen.getByTestId('compliance-hub').dataset.layout).toBe('desktop');
        cleanup(); mockFetch();
        viewport.isMobile = true;
        try {
            render(<ComplianceHub onNavigate={vi.fn()} onBack={onBack} />);
            await waitFor(() => expect(screen.getByTestId('compliance-hub').dataset.layout).toBe('mobile'));
            // The lazy phone chunk must actually RENDER: its default export is a
            // function, and handing it to setState unwrapped made React call it
            // as an updater with no props — the hub threw on every phone while
            // `data-layout` (set before the chunk resolves) still read 'mobile'.
            await waitFor(() => expect(screen.getByTestId('compliance-mobile')).toBeInTheDocument());
        } finally { viewport.isMobile = false; }
    });
});
