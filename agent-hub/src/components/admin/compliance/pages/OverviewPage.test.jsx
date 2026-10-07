import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OverviewPage from './OverviewPage';
import { sectionById } from '../sections';

// One translation seam for the page and every atom under it: the real `t`
// returns the English fallback with `{var}` interpolation, so the assertions
// read as sentences instead of key names.
function tr(key, fallbackOrParams, paramsArg) {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let value = hasFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
}
vi.mock('../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: tr, locale: 'en', resolvedLocale: 'en' }),
}));

const NOW = new Date('2026-09-14T09:00:00Z');

const OVERVIEW = {
    onboarded: true,
    overall: { score: 74, total: 44, pass: 31, warn: 7, fail: 3, na: 3 },
    gdpr: { score: 79, total: 15, pass: 9, warn: 4, fail: 1, na: 1 },
    aia: { score: 58, total: 6, pass: 3, warn: 1, fail: 1, na: 1 },
    iso: { score: 88, total: 23, pass: 19, warn: 2, fail: 0, na: 2 },
    frameworks_detail: {
        gdpr: { score: 79, total: 15, pass: 9, warn: 4, fail: 1, na: 1 },
        aia: { score: 58, total: 6, pass: 3, warn: 1, fail: 1, na: 1 },
        iso27001: { score: 88, total: 23, pass: 19, warn: 2, fail: 0, na: 2 },
    },
    verification_summary_by_framework: {
        gdpr: { automated: { total: 10, pass: 7 }, attestation: { total: 4, pass: 2 }, hybrid: { total: 0, pass: 0 } },
        aia: { automated: { total: 3, pass: 2 }, attestation: { total: 2, pass: 1 }, hybrid: { total: 0, pass: 0 } },
        iso27001: { automated: { total: 21, pass: 19 }, attestation: { total: 0, pass: 0 }, hybrid: { total: 0, pass: 0 } },
    },
    last_run_at: '2026-09-14T09:12:00Z',
    settings: {},
};

const ATTENTION_ITEMS = [
    {
        id: 'GDPR-Art12-notice', code: 'GDPR-Art12-notice', title: 'Privacy notice not published', status: 'fail',
        meta: { severity: 'high', verification: 'attestation', detail: 'URL missing in Settings', frameworks: [{ regulation: 'GDPR', ref: '12' }] },
        action: { type: 'navigate', target: 'admin/compliance/settings', label: 'Open fix' },
    },
    {
        id: 'AIA-Art50-marking', code: 'AIA-Art50-marking', title: 'AI disclosure missing on 2 published agents', status: 'fail',
        meta: { severity: 'high', verification: 'automated', frameworks: [{ regulation: 'AIA', ref: '50' }] },
        action: { type: 'auto_fix', count: 2, label: 'Auto-fix · 2 agents' },
    },
];

const MILESTONES = [
    { id: 'aia_art50', date: '2025-08-02', framework_id: 'aia', kind: 'in_force', label: 'Art. 50 in force', relevant: true },
    { id: 'aia_marking_transition_end', date: '2026-12-02', framework_id: 'aia', kind: 'transition_end', label: 'Mark AI content machine-readable', relevant: true },
    { id: 'pld_in_force', date: '2026-12-09', framework_id: 'pld', kind: 'in_force', label: 'Product liability for software', relevant: true },
    { id: 'data_act_switching', date: '2027-01-12', framework_id: 'data_act', kind: 'phase', label: 'Switching charges abolished', relevant: true },
];

const FRAMEWORK_ROWS = [
    { id: 'gdpr', enabled: true, core: true, in_force_since: '2018-05-25', checks_count: 15 },
    { id: 'aia', enabled: true, core: true, in_force_since: '2024-08-01', checks_count: 6 },
    { id: 'iso27001', enabled: true, core: true, in_force_since: '2022-10-25', checks_count: 23 },
];

function frameworksHook(rows = FRAMEWORK_ROWS) {
    return {
        frameworks: rows,
        byId: (id) => rows.find(f => f.id === id) || null,
        isEnabled: (id) => !!rows.find(f => f.id === id)?.enabled,
    };
}

function baseData(overrides = {}) {
    const { core: coreOv = {}, ...rest } = overrides;
    return {
        core: {
            overview: OVERVIEW, checks: [], scoreHistory: [], loading: false, running: false,
            onboarded: true, settings: {}, autoFixingId: null,
            autoFix: vi.fn(), autoDetect: vi.fn(), finishSetup: vi.fn(), refresh: vi.fn(), runNow: vi.fn(),
            ...coreOv,
        },
        counts: { soa: { approved: 9, total: 93 } },
        attention: { attention: { items: ATTENTION_ITEMS, total: 7, tail: [{ id: 'x', title: 'AI literacy not confirmed', status: 'warn' }], warn_tail_count: 2 }, items: ATTENTION_ITEMS, failed: false },
        deadlines: { items: [], emptyKinds: ['cra_vulnerability'], failed: false },
        frameworks: frameworksHook(),
        calendar: { milestones: MILESTONES, failed: false },
        orgUsers: null,
        ...rest,
    };
}

function renderPage(props = {}) {
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    const onTab = vi.fn();
    const utils = render(
        <OverviewPage
            section={sectionById('overview')}
            tab="status"
            onTab={onTab}
            navigate={navigate}
            onNavigate={onNavigate}
            focusId={null}
            exportsEnabled
            dl={(u) => u}
            api="/api/compliance"
            isMobile={false}
            data={baseData()}
            {...props}
        />,
    );
    return { ...utils, navigate, onNavigate, onTab };
}

describe('OverviewPage — status tab', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });

    it('renders one score card per core framework with its score and breakdown', () => {
        renderPage();
        expect(screen.getByTestId('fw-score-card-gdpr')).toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-aia')).toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-iso27001')).toBeInTheDocument();
        expect(screen.getByTestId('fw-score-card-gdpr-breakdown').textContent)
            .toContain('15 checks · 9 passing · 4 attention · 1 failing · 1 n/a');
        // ISO counts CONTROLS, not checks — the noun is part of the honesty.
        expect(screen.getByTestId('fw-score-card-iso27001-breakdown').textContent).toContain('23 controls');
    });

    it('prices every status colour through the tone tokens, never a hex', () => {
        renderPage();
        const gdpr = screen.getByTestId('fw-score-card-gdpr');
        expect(screen.getByTestId('fw-score-card-gdpr-headline').getAttribute('style')).toContain('var(--warning-ink)');
        expect(gdpr.dataset.tone).toBe('warning');
        expect(screen.getByTestId('fw-score-card-iso27001').dataset.tone).toBe('success');
        expect(gdpr.outerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });

    it('opens the framework section when a card is activated', () => {
        const { navigate } = renderPage();
        fireEvent.click(screen.getByTestId('fw-score-card-iso27001'));
        expect(navigate).toHaveBeenCalledWith('iso');
    });

    it('shows the SoA progress on the ISO card and the next milestone on the AI Act card', () => {
        renderPage();
        expect(screen.getByTestId('fw-score-card-iso27001-chip-soa').textContent).toContain('SoA 9/93 approved');
        expect(screen.getByTestId('fw-score-card-aia-next').textContent).toContain('Mark AI content machine-readable');
    });

    it('lays the attention list beside a 380px clock column and prints the score formula', () => {
        const { container } = renderPage();
        const grid = container.querySelector('.grid-cols-\\[minmax\\(0\\,1fr\\)_380px\\]');
        expect(grid).toBeTruthy();
        // Side by side down to a 960px page: a 1440px laptop with the 300px rail
        // leaves ~1140px, which used to stack everything and push the list below the fold.
        expect(grid.className).toContain('@max-[960px]/cpage:grid-cols-1');
        expect(container.querySelector('[data-testid="overview-scores"]').className).toContain('grid-cols-3');
        expect(container.querySelector('[data-testid="overview-scores"]').className).toContain('@max-[880px]/cpage:grid-cols-2');
        expect(screen.getByTestId('attention-list')).toBeInTheDocument();
        expect(screen.getByTestId('deadlines-card')).toBeInTheDocument();
        expect(screen.getByTestId('upcoming-dates')).toBeInTheDocument();
        expect(screen.getByTestId('overview-formula').textContent).toContain('Σ(weight × status)');
    });
});

describe('OverviewPage — attention states', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });

    it('an unread list is its own state, never an empty one', () => {
        renderPage({ data: baseData({ attention: { attention: null, items: null, failed: true } }) });
        expect(screen.getByTestId('attention-list-unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('attention-list-rows')).not.toBeInTheDocument();
    });

    it('an empty list says everything passes', () => {
        renderPage({ data: baseData({ attention: { attention: { items: [], total: 0 }, items: [], failed: false } }) });
        expect(screen.getByTestId('attention-list-empty')).toBeInTheDocument();
    });

    it('a navigate action reaches the hub with the target section', () => {
        const { navigate } = renderPage();
        const rows = screen.getAllByTestId('attention-list-row');
        fireEvent.click(within(rows[0]).getByTestId('attention-list-row-action'));
        expect(navigate).toHaveBeenCalledWith('settings', undefined, undefined); // (section, id, tab)
    });

    it('an auto-fix asks first and only then calls core.autoFix', () => {
        const autoFix = vi.fn();
        const data = baseData({ core: { autoFix } });
        renderPage({ data });
        const rows = screen.getAllByTestId('attention-list-row');
        fireEvent.click(within(rows[1]).getByTestId('attention-list-row-action'));
        expect(autoFix).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('attention-list-row-confirm-yes'));
        expect(autoFix).toHaveBeenCalledWith('AIA-Art50-marking');
    });
});

describe('OverviewPage — not set up', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });

    it('is ONE path: the inline setup card, no banner and no modal', () => {
        renderPage({ data: baseData({ core: { onboarded: false, overview: { ...OVERVIEW, onboarded: false } } }) });
        expect(screen.getByTestId('setup-card')).toBeInTheDocument();
        expect(screen.getAllByTestId('setup-card-cta')).toHaveLength(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByTestId('attention-list')).not.toBeInTheDocument();
    });

    it('hides the scores behind placeholder rings and keeps the clocks running', () => {
        renderPage({ data: baseData({ core: { onboarded: false, overview: { ...OVERVIEW, onboarded: false } } }) });
        const gdpr = screen.getByTestId('fw-score-card-gdpr');
        expect(gdpr.dataset.placeholder).toBe('true');
        expect(gdpr).not.toHaveAttribute('role', 'button');
        expect(screen.getByTestId('fw-score-card-gdpr-note').textContent).toContain('15 checks are ready');
        expect(screen.getByTestId('fw-score-card-iso27001-note').textContent).toContain('Stage 2');
        expect(screen.getByTestId('overview-clocks-note').textContent).toContain('already work before setup');
        expect(screen.getByTestId('deadlines-card')).toBeInTheDocument();
        expect(screen.getByTestId('upcoming-dates')).toBeInTheDocument();
        expect(screen.queryByTestId('overview-formula')).not.toBeInTheDocument();
    });
});

describe('OverviewPage — calendar and reports tabs', () => {
    beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });

    it('calendar tab shows the full calendar and the AI Act phases', () => {
        renderPage({ tab: 'calendar' });
        expect(screen.getByTestId('overview-calendar-full')).toBeInTheDocument();
        const timeline = screen.getByTestId('overview-aia-timeline');
        const phases = within(timeline).getAllByTestId('overview-aia-timeline-phase');
        expect(phases).toHaveLength(2);
        expect(phases[0].dataset.state).toBe('done');
        expect(phases[1].dataset.state).toBe('upcoming');
    });

    it('a calendar that could not be read says so instead of showing nothing', () => {
        renderPage({ tab: 'calendar', data: baseData({ calendar: { milestones: null, failed: true } }) });
        expect(screen.getByTestId('overview-calendar-unavailable')).toBeInTheDocument();
        expect(screen.queryByTestId('overview-calendar-full')).not.toBeInTheDocument();
    });

    it('reports tab offers every export through dl()', () => {
        renderPage({ tab: 'reports' });
        expect(screen.getByTestId('ovw-reports-dl-report')).toHaveAttribute('href', '/api/compliance/report.pdf');
        expect(screen.getByTestId('ovw-reports-dl-ropa')).toHaveAttribute('href', '/api/compliance/ropa.pdf');
        expect(screen.getByTestId('ovw-reports-dl-bundle')).toHaveAttribute('href', '/api/compliance/iso/evidence-bundle.zip');
    });

    it('reports tab shows one sentence and no links when exports are off', () => {
        renderPage({ tab: 'reports', exportsEnabled: false, dl: () => null });
        expect(screen.getByTestId('ovw-reports-disabled')).toBeInTheDocument();
        expect(screen.queryByTestId('ovw-reports-dl-report')).not.toBeInTheDocument();
    });

    it('drops the ISO pack when ISO is not one of the org\'s frameworks', () => {
        const rows = FRAMEWORK_ROWS.map(f => (f.id === 'iso27001' ? { ...f, enabled: false } : f));
        renderPage({ tab: 'reports', data: baseData({ frameworks: frameworksHook(rows) }) });
        expect(screen.getByTestId('ovw-reports-group-compliance')).toBeInTheDocument();
        expect(screen.queryByTestId('ovw-reports-group-iso')).not.toBeInTheDocument();
    });

    it('"Calendar ↗" sends the hub to Frameworks with the calendar tab in the navigation itself', () => {
        const { navigate, onTab } = renderPage();
        fireEvent.click(screen.getByTestId('upcoming-dates-open'));
        // The tab rides on navigate: a tab set before a host pushes a new URL is lost.
        expect(navigate).toHaveBeenCalledWith('frameworks', undefined, 'calendar');
        expect(onTab).not.toHaveBeenCalled();
    });
});
