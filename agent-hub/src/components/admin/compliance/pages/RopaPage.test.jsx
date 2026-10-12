import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import RopaPage, { sccConfirmedSet, hasDoraColumns } from './RopaPage';
import { TABLE_FOLDED_ONLY } from '../../../shared/DataTable';

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
    legal_bases: ['contract', 'legal_obligation', 'consent'],
    data_residency: 'eu',
    last_reviewed_at: '2026-09-01T10:00:00Z',
    scc_confirmed_operators: [{ operator: 'OpenAI', attested_at: '2026-08-01' }],
    activities: [
        { activity_id: 'agent-1', name: 'Support agent', purpose: 'Answers customer questions', data_categories: ['Names', 'E-mail'], retention: '365 days', transfers: [] },
        { activity_id: 'ops-metrics-push', name: 'Metrics export', purpose: 'Aggregate counts', data_categories: ['Counts only'], retention: 'Receiving store', transfers: ['OpenAI, L.L.C.', 'Anthropic PBC'] },
        { activity_id: 'datatable:tbl_1', name: 'Invoice BI Automator', purpose: 'Invoices', data_categories: ['Names'], retention: '365 days', transfers: [], source: { kind: 'datatable', id: 'tbl_1', scope: { kind: 'org', id: 'orgA' } } },
    ],
    processors: [
        { operator: 'Scaleway', country_code: 'FR', country_name: 'France', is_eu: true, calls: 1200, last_seen: '2026-09-13T08:00:00Z' },
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

/** The last actions the page handed to the header. */
const lastHeaderActions = (setHeaderActions) => setHeaderActions.mock.calls.filter(([a]) => Object.keys(a).length).at(-1)?.[0];

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
    it('writes the controller block in words, not stored values', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-org').textContent).toContain('Bee Flow BV');
        expect(screen.getByTestId('ropa-bases').textContent).toContain('Contract · Legal obligation · Consent');
        expect(screen.getByTestId('ropa-bases').textContent).not.toContain('legal_obligation');
        expect(screen.getByTestId('ropa-residency').textContent).toContain('EU-only');
    });

    it('a value the label tables do not know yet is shown as it is, not dropped', () => {
        render(<RopaPage {...pageProps({ ropa: { ropa: { ...ROPA, legal_bases: ['legitimate_interests', 'something_new'], data_residency: 'moon' } } })} />);
        expect(screen.getByTestId('ropa-bases').textContent).toContain('Legitimate interests · something_new');
        expect(screen.getByTestId('ropa-residency').textContent).toContain('moon');
    });

    it('an activity you can follow — the register was a list of names that went nowhere', async () => {
        const onNavigate = vi.fn();
        render(<RopaPage {...pageProps()} onNavigate={onNavigate} />);
        await userEvent.setup().click(screen.getByTestId('ropa-activity-link-datatable:tbl_1'));
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
        // Operator names carry commas, so the transfers are not comma-joined.
        expect(screen.getByTestId('ropa-activity-ops-metrics-push').textContent).toContain('OpenAI, L.L.C. · Anthropic PBC');
    });

    it('keeps data categories and retention on screen when their columns fold (Art. 30(1)(c)/(f))', () => {
        render(<RopaPage {...pageProps()} />);
        const line = screen.getByTestId('ropa-data-line-agent-1');
        expect(line.textContent).toBe('Data: Names, E-mail · Kept: 365 days');
        for (const cls of TABLE_FOLDED_ONLY[900].split(' ')) expect(line.className).toContain(cls);
    });

    it('hands the review state and both actions to the header, with no toolbar of its own', async () => {
        const review = vi.fn();
        const refresh = vi.fn();
        const props = pageProps({ ropa: { review, refresh } });
        render(<RopaPage {...props} />);
        await waitFor(() => expect(lastHeaderActions(props.setHeaderActions)).toBeTruthy());
        const actions = lastHeaderActions(props.setHeaderActions);
        expect(actions.ropaBusy).toBe(false);
        actions.onMarkRopaReviewed();
        actions.onRegenerateRopa();
        expect(review).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('ropa-review')).toBeNull();
        expect(screen.queryByTestId('ropa-refresh')).toBeNull();
        expect(screen.queryByTestId('ropa-own-actions')).toBeNull();
    });

    it('tells the header while a write is running, and takes its actions back on unmount', async () => {
        const props = pageProps({ ropa: { busy: true } });
        const { unmount } = render(<RopaPage {...props} />);
        await waitFor(() => expect(lastHeaderActions(props.setHeaderActions)?.ropaBusy).toBe(true));
        unmount();
        expect(props.setHeaderActions).toHaveBeenLastCalledWith({});
    });

    it('a host without a header keeps both buttons above the register', async () => {
        const review = vi.fn();
        const refresh = vi.fn();
        const user = userEvent.setup();
        render(<RopaPage {...pageProps({ ropa: { review, refresh } })} setHeaderActions={undefined} />);
        await user.click(screen.getByTestId('ropa-review'));
        await user.click(screen.getByTestId('ropa-refresh'));
        expect(review).toHaveBeenCalled();
        expect(refresh).toHaveBeenCalled();
    });

    it('says EU once: "France · EU" as text, "Not needed" for the transfer basis, no stripe', () => {
        render(<RopaPage {...pageProps()} />);
        expect(screen.getByTestId('ropa-location-Scaleway').textContent).toBe('France · EU');
        expect(screen.getByTestId('ropa-location-OpenAI').textContent).toBe('United States');
        expect(screen.getByTestId('ropa-scc-none-Scaleway').textContent).toBe('Not needed');
        expect(screen.queryByTestId('ropa-scc-Scaleway')).toBeNull();
        expect(screen.queryByTestId('ropa-eu-Scaleway')).toBeNull();
        expect(screen.getByTestId('ropa-processor-Scaleway').dataset.accent).toBeUndefined();
        expect(screen.getByTestId('ropa-processor-OpenAI').dataset.accent).toBeUndefined();
        // Only a non-EU processor without an SCC gets the warning stripe.
        expect(screen.getByTestId('ropa-processor-Fireworks').dataset.accent).toBe('warning');
    });

    it('a missing SCC is a button; an attested one is text, not a toggle', async () => {
        const sccToggle = vi.fn();
        const user = userEvent.setup();
        render(<RopaPage {...pageProps({ ropa: { sccToggle } })} />);
        expect(screen.getByTestId('ropa-scc-Fireworks').textContent).toContain('Attest SCC');
        await user.click(screen.getByTestId('ropa-scc-Fireworks'));
        expect(sccToggle).toHaveBeenCalledWith('Fireworks', true);
        const attested = screen.getByTestId('ropa-scc-OpenAI');
        expect(attested.tagName).not.toBe('BUTTON');
        expect(attested.textContent).toContain('Attested');
        await user.click(attested);
        expect(sccToggle).toHaveBeenCalledTimes(1);
    });

    it('withdrawing an SCC attestation asks first', async () => {
        const sccToggle = vi.fn();
        const user = userEvent.setup();
        render(<RopaPage {...pageProps({ ropa: { sccToggle } })} />);
        await user.click(screen.getByTestId('ropa-scc-menu-OpenAI'));
        await user.click(screen.getByTestId('ropa-scc-withdraw-OpenAI'));
        expect(screen.getByTestId('ropa-scc-confirm-OpenAI').textContent).toContain('Withdraw the SCC attestation for OpenAI?');
        expect(sccToggle).not.toHaveBeenCalled();
        await user.click(screen.getByTestId('ropa-scc-withdraw-cancel-OpenAI'));
        expect(screen.queryByTestId('ropa-scc-confirm-OpenAI')).toBeNull();
        expect(sccToggle).not.toHaveBeenCalled();

        await user.click(screen.getByTestId('ropa-scc-menu-OpenAI'));
        await user.click(screen.getByTestId('ropa-scc-withdraw-OpenAI'));
        await user.click(screen.getByTestId('ropa-scc-withdraw-go-OpenAI'));
        expect(sccToggle).toHaveBeenCalledWith('OpenAI', false);
    });

    it('the withdraw menu works from the keyboard and gives the focus back', async () => {
        const user = userEvent.setup();
        render(<RopaPage {...pageProps()} />);
        const trigger = screen.getByTestId('ropa-scc-menu-OpenAI');
        expect(trigger.getAttribute('aria-label')).toBe('Transfer basis options for OpenAI');
        trigger.focus();
        await user.keyboard('{ArrowDown}');
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ropa-scc-withdraw-OpenAI')));
        await user.keyboard('{Enter}');
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ropa-scc-withdraw-cancel-OpenAI')));
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('ropa-scc-confirm-OpenAI')).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(trigger));
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
        expect(activity.textContent).toMatch(/Data: Names, E-mail · Kept: 365 days/);
        expect(activity.textContent).toMatch(/None outside the EU/);
        const eu = screen.getByTestId('ropa-processor-card-Scaleway');
        expect(eu.textContent).toMatch(/France · EU/);
        expect(screen.getByTestId('ropa-scc-none-card-Scaleway')).toBeTruthy();
        expect(screen.queryByTestId('ropa-activity-agent-1')).toBeNull();
    });

    it('labels the numbers on a processor card', () => {
        render(<RopaPage {...pageProps({ isMobile: true })} />);
        expect(screen.getByTestId('ropa-calls-card-Scaleway').textContent).toMatch(/^1,200 calls · last 13 Sep( 2026)?$/);
        expect(screen.getByTestId('ropa-calls-card-Fireworks').textContent).toBe('5 calls');
    });

    it('a non-EU processor keeps its SCC action, and the withdraw menu, as 44px targets', async () => {
        const props = pageProps({ isMobile: true });
        render(<RopaPage {...props} />);
        const btn = screen.getByTestId('ropa-scc-card-Fireworks');
        expect(btn.className).toMatch(/min-h-\[44px\]/);
        await userEvent.setup().click(btn);
        expect(props.data.ropa.sccToggle).toHaveBeenCalledWith('Fireworks', true);
        expect(screen.getByTestId('ropa-scc-menu-card-OpenAI').className).toMatch(/min-h-\[44px\]/);
    });
});
