import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTab, tabsOf } from '../sections';
import { statusChipOf, enableIsPrimary } from './frameworks/FrameworkCandidateCard';
import { frameworkIcon } from './frameworks/frameworkIcons';
import FrameworksPage, { candidateList, frameworkGroups, LICENSE_PATH } from './FrameworksPage';

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

const NOW = new Date('2026-09-14T10:00:00Z').getTime();

function frameworks() {
    return [
        { id: 'gdpr', core: true, enabled: true, name_key: 'compliance.fw_gdpr_name', in_force_since: '2018-05-25' },
        {
            id: 'aia', core: true, enabled: true, name_key: 'compliance.fw_aia_name', in_force_since: '2025-02-02', score: { score: 58 },
            phases: [
                { date: '2025-02-02', label_key: 'compliance.fw_aia_phase_art4_art5' },
                { date: '2026-08-02', label_key: 'compliance.fw_aia_phase_art50' },
                { date: '2026-12-02', label_key: 'compliance.fw_aia_phase_marking_transition_end' },
                { date: '2028-08-02', label_key: 'compliance.fw_aia_phase_annex_i' },
            ],
        },
        { id: 'nis2', core: false, enabled: false, locked: 'ceiling', lock: { feature: 'compliance_hub_nis2' }, name_key: 'compliance.fw_nis2_name', description_key: 'compliance.fw_nis2_desc', affects_key: 'compliance.fw_nis2_affects', in_force_since: '2026-08-15', checks_count: 4, registers: ['incidents'], calendar_count: 1, relevance: 'unknown' },
        { id: 'cra', core: false, enabled: false, locked: null, name_key: 'compliance.fw_cra_name', description_key: 'compliance.fw_cra_desc', affects_key: 'compliance.fw_cra_affects', in_force_since: '2026-09-11', recently_in_force: true, checks_count: 3, registers: ['vulnerabilities'], calendar_count: 2, relevance: 'unknown' },
        { id: 'pld', core: false, enabled: false, locked: null, name_key: 'compliance.fw_pld_name', in_force_from: '2026-12-09', checks_count: 3, registers: [], calendar_count: 1, relevance: 'unknown' },
        { id: 'dora', core: false, enabled: false, locked: null, name_key: 'compliance.fw_dora_name', in_force_since: '2025-01-17', checks_count: 2, registers: [], calendar_count: 1, relevance: 'not_relevant', relevance_gate: true },
        { id: 'machinery', core: false, enabled: false, locked: 'not_granted', name_key: 'compliance.fw_machinery_name', in_force_from: '2027-01-20', checks_count: 2, registers: [], calendar_count: 1, relevance: 'unknown', relevance_gate: true },
        { id: 'eaa', core: false, enabled: true, locked: null, name_key: 'compliance.fw_eaa_name', in_force_since: '2025-06-28', checks_count: 2, registers: [], calendar_count: 1, relevance: 'unknown' },
    ];
}

function milestones() {
    return [
        { id: 'aia_art4', date: '2025-02-02', framework_id: 'aia', kind: 'phase', label_key: 'compliance.cal_ms_aia_art4_label', detail_key: 'compliance.cal_ms_aia_art4_detail', relevant: true },
        { id: 'nis2_in_force', date: '2026-08-15', framework_id: 'nis2', kind: 'in_force', label_key: 'compliance.cal_ms_nis2_label', detail_key: 'compliance.cal_ms_nis2_detail', relevant: true },
        { id: 'aia_marking', date: '2026-12-02', framework_id: 'aia', kind: 'transition_end', label_key: 'compliance.cal_ms_aia_marking_label', detail_key: 'compliance.cal_ms_aia_marking_detail', relevant: true, affects: { automations: 3 } },
        { id: 'omnibus', date: null, framework_id: null, kind: 'uncertain', label_key: 'compliance.cal_ms_omnibus_label', detail_key: 'compliance.cal_ms_omnibus_detail', relevant: true },
    ];
}

function pageProps(over = {}) {
    const list = over.frameworks ?? frameworks();
    const fw = {
        frameworks: list,
        active: list.filter(f => f.enabled),
        candidates: list.filter(f => !f.enabled && !f.core),
        custom: [],
        byId: (id) => list.find(f => f.id === id) || null,
        isEnabled: (id) => !!list.find(f => f.id === id)?.enabled,
        busyId: null,
        failed: false,
        enable: vi.fn(() => Promise.resolve({})),
        disable: vi.fn(() => Promise.resolve({})),
        setRelevance: vi.fn(() => Promise.resolve({})),
        refresh: vi.fn(),
        ...(over.fw || {}),
    };
    return {
        section: { id: 'frameworks', tabs: [] },
        tab: over.tab ?? null,
        onTab: vi.fn(),
        navigate: vi.fn(),
        onNavigate: vi.fn(),
        setHeaderActions: vi.fn(),
        isMobile: false,
        now: NOW,
        data: {
            core: { checks: over.checks ?? [], refresh: vi.fn(() => Promise.resolve()) },
            bump: vi.fn(),
            frameworks: fw,
            calendar: { milestones: over.milestones ?? milestones(), failed: false },
        },
        ...(over.props || {}),
    };
}

describe('FrameworksPage — all tab', () => {
    it('groups the non-core frameworks into Enabled and Available, the own-framework door last, and no core cards', () => {
        render(<FrameworksPage {...pageProps()} />);
        const enabled = screen.getByTestId('fw-group-enabled');
        const available = screen.getByTestId('fw-group-available');
        expect(within(enabled).getByRole('heading', { name: 'Enabled' })).toBeTruthy();
        expect(within(available).getByRole('heading', { name: 'Available' })).toBeTruthy();
        expect(available).toHaveTextContent('not enabled yet');
        const ids = (el) => [...el.querySelectorAll('[data-framework]')].map(c => c.dataset.framework);
        expect(ids(enabled)).toEqual(['eaa']);
        expect(ids(available)).toEqual(['nis2', 'cra', 'pld', 'dora', 'machinery']);
        const grid = screen.getByTestId('fw-grid');
        expect(grid.lastElementChild).toBe(screen.getByTestId('fw-card-own'));
        expect(candidateList(frameworks()).some(f => f.core)).toBe(false);
        expect(screen.queryByText('Candidates')).toBeNull();
    });

    it('no AI Act phasing card here: the phasing is the AI Act page\'s Timeline tab', () => {
        render(<FrameworksPage {...pageProps({ checks: [{ regulation: 'AIA', article: '50', status: 'fail' }] })} />);
        expect(screen.queryByTestId('aia-phases-card')).toBeNull();
        expect(screen.queryByTestId('timeline-phases')).toBeNull();
        expect(screen.queryByText('AI Act — phasing')).toBeNull();
    });

    it('without enabled optional frameworks there is no Enabled heading, only Available', () => {
        const list = frameworks().map(f => (f.core ? f : { ...f, enabled: false }));
        render(<FrameworksPage {...pageProps({ frameworks: list })} />);
        expect(screen.queryByTestId('fw-group-enabled')).toBeNull();
        expect(screen.getByTestId('fw-group-available')).toBeTruthy();
    });

    it('a locked framework shows the lock hint and "View plan" navigates to the licence page — it is never hidden', async () => {
        const user = userEvent.setup();
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const nis2 = screen.getByTestId('fw-card-nis2');
        expect(nis2.dataset.locked).toBe('ceiling');
        expect(nis2.querySelector('[data-testid="fw-locked"]').textContent).toContain('Available on a higher plan');
        expect(nis2.querySelector('[data-testid="fw-enable"]')).toBeNull();
        await user.click(nis2.querySelector('[data-testid="fw-view-plan"]'));
        expect(props.onNavigate).toHaveBeenCalledWith(LICENSE_PATH);
        expect(LICENSE_PATH).toBe('settings/organisation/license');

        const mach = screen.getByTestId('fw-card-machinery');
        expect(mach.querySelector('[data-testid="fw-locked"]').textContent).toContain('ask an admin');
    });

    it('the status chip follows the dates: in force → success tint, from ≤ 90 d → warning with days, further → hairline', () => {
        render(<FrameworksPage {...pageProps()} />);
        const chip = (id) => screen.getByTestId(`fw-card-${id}`).querySelector('[data-testid="fw-status-chip"]');
        expect(chip('cra').dataset.tone).toBe('success');
        expect(chip('cra').textContent).toMatch(/in force since 11 Sep 2026/);
        expect(chip('pld').dataset.tone).toBe('warning');
        expect(chip('pld').textContent).toMatch(/from 9 Dec 2026 · in 86 days/);
        expect(chip('machinery').dataset.tone).toBe('neutral');
        expect(chip('machinery').textContent).toMatch(/^from 20 Jan 2027$/);
        expect(chip('machinery').style.border).toContain('var(--border-default)');
    });

    it('enable flow: primary button when recently in force, secondary otherwise; click → enable(id), bump(), core.refresh()', async () => {
        const user = userEvent.setup();
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const craEnable = screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-enable"]');
        const pldEnable = screen.getByTestId('fw-card-pld').querySelector('[data-testid="fw-enable"]');
        expect(craEnable.dataset.primary).toBe('true');
        expect(craEnable.style.background).toBe('var(--accent-primary)');
        expect(pldEnable.dataset.primary).toBe('false');
        expect(screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-meta"]').textContent).toBe('3 checks · 1 register · 2 calendar dates');

        await user.click(craEnable);
        expect(props.data.frameworks.enable).toHaveBeenCalledWith('cra');
        await waitFor(() => expect(props.data.bump).toHaveBeenCalledTimes(1));
        expect(props.data.core.refresh).toHaveBeenCalledTimes(1);
    });

    it('an enabled framework shows "Enabled · n checks" and a Disable secondary', async () => {
        const user = userEvent.setup();
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const eaa = screen.getByTestId('fw-card-eaa');
        expect(eaa.querySelector('[data-testid="fw-enabled-meta"]').textContent).toBe('Enabled · 2 checks');
        await user.click(eaa.querySelector('[data-testid="fw-disable"]'));
        expect(props.data.frameworks.disable).toHaveBeenCalledWith('eaa');
        await waitFor(() => expect(props.data.bump).toHaveBeenCalled());
    });

    it('relevance chip on gated frameworks toggles setRelevance', async () => {
        const user = userEvent.setup();
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const dora = screen.getByTestId('fw-card-dora').querySelector('[data-testid="fw-relevance"]');
        expect(dora.getAttribute('aria-pressed')).toBe('true');
        await user.click(dora);
        expect(props.data.frameworks.setRelevance).toHaveBeenCalledWith('dora', 'relevant');
        // machinery is gated too, but locked cards show the lock footer instead
        expect(screen.getByTestId('fw-card-machinery').querySelector('[data-testid="fw-relevance"]')).toBeNull();
        expect(screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-relevance"]')).toBeNull();
    });

    it('the calendar card is the right column: the full variant with a today divider; the own-framework card opens the custom page', async () => {
        const user = userEvent.setup();
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        expect(screen.getByTestId('cal-today')).toBeTruthy();
        expect(screen.getAllByTestId('cal-row').length).toBe(3);
        expect(screen.getByTestId('fw-calendar-card')).toBeTruthy();
        await user.click(screen.getByTestId('fw-card-own'));
        expect(props.navigate).toHaveBeenCalledWith('custom');
        expect(props.setHeaderActions).toHaveBeenCalledWith(expect.objectContaining({ onAddFramework: expect.any(Function) }));
    });

    it('a failed framework read is its own state, a null list is loading — never an empty grid', () => {
        const { unmount } = render(<FrameworksPage {...pageProps({ frameworks: [], fw: { frameworks: null, failed: true } })} />);
        expect(screen.getByTestId('fw-failed')).toBeTruthy();
        unmount();
        render(<FrameworksPage {...pageProps({ frameworks: [], fw: { frameworks: null, failed: false } })} />);
        expect(screen.getByTestId('fw-loading')).toBeTruthy();
        expect(screen.queryByTestId('fw-grid')).toBeNull();
    });
});

describe('FrameworksPage — one view; the old tabs moved', () => {
    it('has no tabs; ?tab=calendar lands on Overview › Calendar and ?tab=per_automation on AI Act › Systems', () => {
        expect(tabsOf('frameworks')).toEqual([]);
        expect(resolveTab('frameworks', 'calendar')).toEqual({ section: 'overview', tab: 'calendar' });
        expect(resolveTab('frameworks', 'per_automation')).toEqual({ section: 'aia', tab: 'systems' });
    });

    it('an old tab value renders the one view, never a blank page', () => {
        render(<FrameworksPage {...pageProps({ tab: 'per_automation' })} />);
        expect(screen.getByTestId('fw-grid')).toBeTruthy();
        expect(screen.getByTestId('fw-calendar-card')).toBeTruthy();
        expect(screen.queryByTestId('fw-per-automation')).toBeNull();
    });
});

describe('pure helpers', () => {
    it('statusChipOf / enableIsPrimary / frameworkGroups / frameworkIcon', () => {
        expect(statusChipOf({ in_force_since: '2025-01-01' }, NOW).tone).toBe('success');
        expect(statusChipOf({ in_force_from: '2026-10-01' }, NOW)).toMatchObject({ tone: 'warning', days: 17 });
        expect(statusChipOf({ in_force_from: '2027-06-01' }, NOW).tone).toBe('neutral');
        expect(statusChipOf({}, NOW)).toBeNull();
        expect(enableIsPrimary({ recently_in_force: true })).toBe(true);
        expect(enableIsPrimary({ relevance: 'relevant' })).toBe(true);
        expect(enableIsPrimary({ relevance: 'unknown' })).toBe(false);
        expect(frameworkGroups(null)).toBeNull();
        const groups = frameworkGroups(frameworks());
        expect(groups.enabled.map(f => f.id)).toEqual(['eaa']);
        expect(groups.available.map(f => f.id)).toEqual(['nis2', 'cra', 'pld', 'dora', 'machinery']);
        expect(frameworkIcon('data_act')).toBe(frameworkIcon('DATA-ACT'));
        expect(frameworkIcon('unknown')).toBe(frameworkIcon(null));
    });
});
