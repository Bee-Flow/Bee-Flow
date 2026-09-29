import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import RopaPage, { sccConfirmedSet, hasDoraColumns } from './RopaPage';

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

afterEach(cleanup);

const ROPA = {
    organization_id: 'org1',
    controller: { name: 'Bee Flow BV', dpo_name: 'Jane Doe', dpo_email: 'dpo@example.com' },
    legal_bases: ['contract', 'consent'],
    data_residency: 'eu',
    last_reviewed_at: '2026-09-01T10:00:00Z',
    scc_confirmed_operators: [{ operator: 'OpenAI', attested_at: '2026-08-01' }],
    activities: [
        { activity_id: 'agent-1', name: 'Support agent', purpose: 'Answers customer questions', data_categories: ['Names', 'E-mail'], retention: '365 days', transfers: [] },
        { activity_id: 'ops-metrics-push', name: 'Metrics export', purpose: 'Aggregate counts', data_categories: ['Counts only'], retention: 'Receiving store', transfers: ['US'] },
        { activity_id: 'datatable:tbl_1', name: 'Invoice BI Automator', purpose: 'Invoices', data_categories: ['Names'], retention: '365 days', transfers: [], source: { kind: 'datatable', id: 'tbl_1', scope: { kind: 'org', id: 'orgA' } } },
    ],
    processors: [
        { operator: 'Scaleway', country_code: 'FR', country_name: 'France', is_eu: true, calls: 120, last_seen: '2026-09-13T08:00:00Z' },
        { operator: 'OpenAI', country_code: 'US', country_name: 'United States', is_eu: false, calls: 40, last_seen: '2026-09-12T08:00:00Z', scc_confirmed: true },
        { operator: 'Fireworks', country_code: 'US', country_name: 'United States', is_eu: false, calls: 5, last_seen: null },
    ],
};

function ropaState(over = {}) {
    return { ropa: ROPA, busy: false, refresh: vi.fn(), review: vi.fn(), sccToggle: vi.fn(), ...over };
}

function pageProps(over = {}) {
    const { ropa, ...rest } = over;
    return {
        section: { id: 'ropa' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { ropa: ropaState(ropa) },
        ...rest,
    };
}

describe('sccConfirmedSet / hasDoraColumns', () => {
    it('reads the attested operators case-insensitively', () => {
        const set = sccConfirmedSet({ scc_confirmed_operators: [{ operator: 'OpenAI' }, 'Groq', null] });
        expect(set.has('openai')).toBe(true);
        expect(set.has('groq')).toBe(true);
        expect(set.size).toBe(2);
    });
    it('shows the DORA columns only when a row carries one', () => {
        expect(hasDoraColumns(ROPA.processors)).toBe(false);
        expect(hasDoraColumns([{ contract_ref: 'C-1' }])).toBe(true);
        expect(hasDoraColumns([{ critical: false }])).toBe(true);
        expect(hasDoraColumns(null)).toBe(false);
    });
});

describe('RopaPage', () => {
    it('renders the controller block from the synthesis', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-org').textContent).toContain('Bee Flow BV');
        expect(screen.getByTestId('ropa-bases').textContent).toContain('contract, consent');
    });

    it('an activity you can follow — the register was a list of names that went nowhere', () => {
        const onNavigate = vi.fn();
        render(<RopaPage {...pageProps()} onNavigate={onNavigate} />);
        fireEvent.click(screen.getByTestId('ropa-activity-link-datatable:tbl_1'));
        expect(onNavigate).toHaveBeenCalledWith('studio/datatables/tbl_1');
        // An activity with no source behind it stays words, not a dead link.
        expect(screen.queryByTestId('ropa-activity-link-agent-1')).toBeNull();
        expect(screen.getByTestId('ropa-activity-agent-1').textContent).toContain('Support agent');
    });

    it('lists the activities and the processors', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-activity-agent-1')).toBeTruthy();
        expect(screen.getByTestId('ropa-processor-Scaleway')).toBeTruthy();
        expect(screen.getByTestId('ropa-processor-OpenAI')).toBeTruthy();
    });

    it('says when the register was last reviewed, and when it never was', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-intro').textContent).toContain('Last reviewed');
        cleanup();
        render(<RopaPage {...pageProps({ ropa: { ropa: { ...ROPA, last_reviewed_at: null } } })} />);
        expect(screen.getByTestId('ropa-intro').textContent).toContain('never been reviewed');
    });

    it('marks the register reviewed through the hook', () => {
        const review = vi.fn();
        render(<RopaPage {...pageProps({ ropa: { review } })} />);
        fireEvent.click(screen.getByTestId('ropa-review'));
        expect(review).toHaveBeenCalled();
    });

    it('rebuilds through the hook refresh', () => {
        const refresh = vi.fn();
        render(<RopaPage {...pageProps({ ropa: { refresh } })} />);
        fireEvent.click(screen.getByTestId('ropa-refresh'));
        expect(refresh).toHaveBeenCalled();
    });

    it('an EU processor needs no transfer basis; a non-EU one gets the toggle', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-scc-none-Scaleway')).toBeTruthy();
        expect(screen.queryByTestId('ropa-scc-Scaleway')).toBeNull();
        expect(screen.getByTestId('ropa-scc-OpenAI').textContent).toContain('SCCs in place');
        expect(screen.getByTestId('ropa-scc-Fireworks').textContent).toContain('Confirm SCCs');
    });

    it('toggles an SCC attestation on and off', () => {
        const sccToggle = vi.fn();
        render(<RopaPage {...pageProps({ ropa: { sccToggle } })} />);
        fireEvent.click(screen.getByTestId('ropa-scc-Fireworks'));
        expect(sccToggle).toHaveBeenCalledWith('Fireworks', true);
        fireEvent.click(screen.getByTestId('ropa-scc-OpenAI'));
        expect(sccToggle).toHaveBeenCalledWith('OpenAI', false);
    });

    it('hides the DORA register columns for an org that keeps none', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.queryByTestId('ropa-contract-OpenAI')).toBeNull();
        expect(screen.queryByTestId('ropa-critical-OpenAI')).toBeNull();
    });

    it('shows the DORA register columns as soon as the contract facts are there', () => {
        const processors = [
            { operator: 'OpenAI', country_code: 'US', is_eu: false, calls: 40, contract_ref: 'C-2026-1', critical: true, country: 'IE', scc_confirmed: true },
        ];
        render(<RopaPage {...pageProps({ ropa: { ropa: { ...ROPA, processors } } })} />);
        expect(screen.getByTestId('ropa-contract-OpenAI').textContent).toBe('C-2026-1');
        expect(screen.getByTestId('ropa-critical-OpenAI').textContent).toContain('Critical');
        expect(screen.getByTestId('ropa-country-OpenAI').textContent).toBe('IE');
    });

    it('offers the PDF only while downloads are allowed', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-pdf').getAttribute('href')).toBe('/api/compliance/ropa.pdf');
        cleanup();
        const { container } = render(<RopaPage {...pageProps()} dl={() => null} />);
        expect(container.querySelector('a[download]')).toBeNull();
        cleanup();
        const second = render(<RopaPage {...pageProps()} exportsEnabled={false} />);
        expect(second.container.querySelector('a[download]')).toBeNull();
    });

    it('a failed synthesis is its own state, not an empty register', () => {
        render(<RopaPage {...pageProps({ ropa: { ropa: { error: 'boom' } } })} />);
        expect(screen.getByTestId('ropa-failed')).toBeTruthy();
        expect(screen.queryByTestId('ropa-activities-table')).toBeNull();
    });

    it('shows skeletons while the register is being built', () => {
        render(<RopaPage {...pageProps({ ropa: { ropa: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });
});

describe('RopaPage — phone (artboard 1h)', () => {
    it('both registers take the card path and keep the row data', () => {
        render(<RopaPage {...pageProps({ isMobile: true })} />);
        expect(screen.getByTestId('ropa-activities-table').dataset.view).toBe('cards');
        expect(screen.getByTestId('ropa-processors-table').dataset.view).toBe('cards');
        const activity = screen.getByTestId('ropa-activity-card-agent-1');
        expect(activity.textContent).toMatch(/Support agent/);
        expect(activity.textContent).toMatch(/365 days/);
        expect(activity.textContent).toMatch(/None outside the EU/);
        const eu = screen.getByTestId('ropa-processor-card-Scaleway');
        expect(eu.textContent).toMatch(/France/);
        expect(screen.getByTestId('ropa-scc-none-card-Scaleway')).toBeTruthy();
        expect(screen.queryByTestId('ropa-activity-agent-1')).toBeNull();
    });

    it('a non-EU processor keeps its SCC action as a 44px target', () => {
        const props = pageProps({ isMobile: true });
        render(<RopaPage {...props} />);
        const btn = screen.getByTestId('ropa-scc-card-Fireworks');
        expect(btn.className).toMatch(/min-h-\[44px\]/);
        fireEvent.click(btn);
        expect(props.data.ropa.sccToggle).toHaveBeenCalledWith('Fireworks', true);
    });
});
