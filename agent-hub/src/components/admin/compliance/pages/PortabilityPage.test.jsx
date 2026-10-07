import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import PortabilityPage, { rowTone, isPortable, coverageSummary, routeLines } from './PortabilityPage';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const fetchJson = vi.fn();
vi.mock('../data/api', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, fetchJson: (...args) => fetchJson(...args) };
});

afterEach(cleanup);
beforeEach(() => { fetchJson.mockReset(); });

function matrix() {
    return [
        {
            kind: 'automations', label_key: 'compliance.pf_kind_automations', held: 12, held_scope: 'org',
            route: { method: 'GET', path: '/api/automation/:id/export' }, extra_routes: [], render_only: null,
            formats: ['json'], scope: 'per-item', mounted: true, gap_key: null,
        },
        {
            kind: 'cms_sites', label_key: 'compliance.pf_kind_cms_sites', held: 3, held_scope: 'platform',
            route: { method: 'GET', path: '/api/cms/sites/:siteId/export' }, extra_routes: [], render_only: null,
            formats: ['zip', 'json'], scope: 'per-item', mounted: true, gap_key: null,
        },
        {
            kind: 'notebooks', label_key: 'compliance.pf_kind_notebooks', held: null, held_scope: 'org',
            route: { method: 'POST', path: '/api/notebooks/:id/export/docx' },
            extra_routes: [{ method: 'POST', path: '/api/notebooks/:id/export/pdf' }], render_only: null,
            formats: ['docx', 'pdf'], scope: 'per-item', mounted: false, gap_key: null,
        },
        {
            kind: 'agents', label_key: 'compliance.pf_kind_agents', held: 7, held_scope: 'org',
            route: null, extra_routes: [], render_only: null, formats: [], scope: 'per-item',
            mounted: false, gap_key: 'compliance.pf_gap_agents',
        },
        {
            kind: 'ai_webpages', label_key: 'compliance.pf_kind_ai_webpages', held: 2, held_scope: 'org',
            route: null, extra_routes: [],
            render_only: { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] },
            formats: [], scope: 'per-item', mounted: false, gap_key: 'compliance.pf_gap_ai_webpages',
        },
    ];
}

const props = (over = {}) => ({ isMobile: false, setHeaderActions: vi.fn(), ...over });

describe('PortabilityPage', () => {
    it('reads GET /portability and renders one row per kind', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('pf-row').length).toBe(5));
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/portability$/);
        expect([...screen.getAllByTestId('pf-kind')].map(el => el.dataset.kind))
            .toEqual(['automations', 'cms_sites', 'notebooks', 'agents', 'ai_webpages']);
    });

    it('a kind without an export route renders in error ink with the product-gap note and no format chips', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('pf-gap').length).toBe(2));
        const gap = screen.getAllByTestId('pf-gap')[0];
        expect(gap.style.color).toBe('var(--error-ink)');
        expect(gap.textContent).toContain('No export route');
        const rows = screen.getAllByTestId('pf-row');
        // agents is the fourth row: accent stripe in the error tone
        expect(rows[3].style.boxShadow).toContain('var(--error)');
        expect(rows[0].style.boxShadow).toBe('');
    });

    it('a declared route that is no longer served is red too — a broken export is not a covered export', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('pf-row').length).toBe(5));
        const flags = screen.getAllByTestId('pf-mounted');
        expect(flags.map(f => f.dataset.mounted)).toEqual(['true', 'true', 'false', 'none', 'none']);
        expect(flags[2].style.color).toBe('var(--error-ink)');
        expect(flags[0].style.color).toBe('var(--success-ink)');
        expect(screen.getAllByTestId('pf-row')[2].style.boxShadow).toContain('var(--error)');
    });

    it('lists every declared route, marks a render-only one, and never prints a 0 for an unknown count', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getAllByTestId('pf-row').length).toBe(5));
        const routeCells = screen.getAllByTestId('pf-route');
        expect(routeCells.map(r => r.textContent.trim())).toEqual([
            'GET /api/automation/:id/export',
            'GET /api/cms/sites/:siteId/export',
            'POST /api/notebooks/:id/export/docx',
            'POST /api/notebooks/:id/export/pdf',
        ]);
        expect(screen.getByTestId('pf-route-render-only').textContent).toContain('renders, does not migrate');
        // notebooks has held === null → an em dash, never a zero
        const held = screen.getAllByTestId('pf-held').map(el => el.textContent);
        expect(held).toEqual(['12', '3', '7', '2']);
        expect(screen.getAllByTestId('pf-row')[2].textContent).not.toMatch(/\b0\b/);
    });

    it('names the platform-wide kind, and reports the coverage to the header with its refresh', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        const p = props();
        render(<PortabilityPage {...p} />);
        await waitFor(() => expect(screen.getByTestId('pf-footer')).toBeTruthy());
        expect(screen.getAllByTestId('pf-row')[1].textContent).toContain('platform-wide');
        await waitFor(() => expect(p.setHeaderActions).toHaveBeenCalledWith(
            expect.objectContaining({ portabilityCoverage: { total: 5, portable: 2, held: 4 }, onRefreshPortability: expect.any(Function) }),
        ));
    });

    it('says the coverage once in the body: the footer sentence, not a second pill in the intro', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getByTestId('pf-footer')).toBeTruthy());
        expect(screen.getByTestId('pf-footer').textContent).toContain('2 of 5 kinds have a working export route');
        expect(screen.queryByTestId('pf-coverage')).toBeNull();
        expect(screen.getByTestId('pf-intro').textContent).not.toMatch(/of 5/);
        expect(screen.getByTestId('portability-page').textContent.match(/2 of 5/g)).toHaveLength(1);
    });

    it('a failed read is its own state, not an empty matrix', async () => {
        fetchJson.mockRejectedValueOnce(new Error('404 Not Found'));
        render(<PortabilityPage {...props()} />);
        await waitFor(() => expect(screen.getByTestId('portability-page-failed')).toBeTruthy());
        expect(screen.queryByTestId('pf-table')).toBeNull();
        expect(screen.queryByTestId('pf-row')).toBeNull();
    });

    it('shows skeleton rows while the matrix is loading', () => {
        fetchJson.mockReturnValueOnce(new Promise(() => {}));
        render(<PortabilityPage {...props()} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('pf-footer')).toBeNull();
    });
});

describe('pure helpers', () => {
    it('rowTone / isPortable / coverageSummary / routeLines', () => {
        const ok = { route: { method: 'GET', path: '/x' }, mounted: true, extra_routes: [] };
        const broken = { route: { method: 'GET', path: '/x' }, mounted: false, extra_routes: [] };
        const gap = { route: null, mounted: false, extra_routes: [] };
        expect(rowTone(ok)).toBe('success');
        expect(rowTone(broken)).toBe('error');
        expect(rowTone(gap)).toBe('error');
        expect(rowTone(null)).toBe('neutral');
        expect(isPortable(ok)).toBe(true);
        expect(isPortable(broken)).toBe(false);
        expect(isPortable(undefined)).toBe(false);

        expect(coverageSummary(null)).toBeNull();
        expect(coverageSummary(matrix())).toEqual({ total: 5, portable: 2, held: 4 });

        expect(routeLines(matrix()[2]).map(r => r.role)).toEqual(['primary', 'extra']);
        expect(routeLines(matrix()[4]).map(r => r.role)).toEqual(['render_only']);
        expect(routeLines(null)).toEqual([]);
    });
});

describe('PortabilityPage — phone (artboard 1h)', () => {
    it('takes the card path: one card per kind, gaps and routes kept', async () => {
        fetchJson.mockResolvedValueOnce(matrix());
        render(<PortabilityPage {...props({ isMobile: true })} />);
        await waitFor(() => expect(screen.getAllByTestId('pf-card').length).toBe(5));
        expect(screen.getByTestId('pf-table').dataset.view).toBe('cards');
        expect(screen.queryAllByTestId('pf-row').length).toBe(0);
        expect([...screen.getAllByTestId('pf-kind')].map(el => el.dataset.kind))
            .toEqual(['automations', 'cms_sites', 'notebooks', 'agents', 'ai_webpages']);
        expect(screen.getAllByTestId('pf-gap').length).toBe(2);
        expect(screen.getAllByTestId('pf-route')[0].textContent).toMatch(/GET \/api\/automation\/:id\/export/);
    });
});
