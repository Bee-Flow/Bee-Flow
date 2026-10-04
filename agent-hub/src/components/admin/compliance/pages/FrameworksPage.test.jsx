import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import FrameworksPage, { candidateList, LICENSE_PATH } from './FrameworksPage';
import { statusChipOf, enableIsPrimary } from './frameworks/FrameworkCandidateCard';
import { phaseStates, disclosureFails } from './frameworks/AiActPhasesCard';
import { frameworkIcon } from './frameworks/frameworkIcons';

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
vi.mock('../../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(cleanup);
beforeEach(() => { fetchJson.mockReset(); });

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
        section: { id: 'frameworks', tabs: ['all', 'calendar', 'per_automation'] },
        tab: over.tab ?? 'all',
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
    it('renders every non-core framework as a card, the own-framework door last, and no core cards', () => {
        render(<FrameworksPage {...pageProps()} />);
        const grid = screen.getByTestId('fw-grid');
        const cards = grid.querySelectorAll('[data-framework]');
        expect([...cards].map(c => c.dataset.framework)).toEqual(['nis2', 'cra', 'pld', 'dora', 'machinery', 'eaa']);
        expect(grid.lastElementChild).toBe(screen.getByTestId('fw-card-own'));
        expect(candidateList(frameworks()).some(f => f.core)).toBe(false);
    });

    it('a locked framework shows the lock hint and "View plan" navigates to the licence page — it is never hidden', () => {
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const nis2 = screen.getByTestId('fw-card-nis2');
        expect(nis2.dataset.locked).toBe('ceiling');
        expect(nis2.querySelector('[data-testid="fw-locked"]').textContent).toContain('Available on a higher plan');
        expect(nis2.querySelector('[data-testid="fw-enable"]')).toBeNull();
        fireEvent.click(nis2.querySelector('[data-testid="fw-view-plan"]'));
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
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const craEnable = screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-enable"]');
        const pldEnable = screen.getByTestId('fw-card-pld').querySelector('[data-testid="fw-enable"]');
        expect(craEnable.dataset.primary).toBe('true');
        expect(craEnable.style.background).toBe('var(--accent-primary)');
        expect(pldEnable.dataset.primary).toBe('false');
        expect(screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-meta"]').textContent).toBe('3 checks · 1 registers · 2 calendar dates');

        fireEvent.click(craEnable);
        expect(props.data.frameworks.enable).toHaveBeenCalledWith('cra');
        await waitFor(() => expect(props.data.bump).toHaveBeenCalledTimes(1));
        expect(props.data.core.refresh).toHaveBeenCalledTimes(1);
    });

    it('an enabled framework shows "Enabled · n checks" and a Disable secondary', async () => {
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const eaa = screen.getByTestId('fw-card-eaa');
        expect(eaa.querySelector('[data-testid="fw-enabled-meta"]').textContent).toBe('Enabled · 2 checks');
        fireEvent.click(eaa.querySelector('[data-testid="fw-disable"]'));
        expect(props.data.frameworks.disable).toHaveBeenCalledWith('eaa');
        await waitFor(() => expect(props.data.bump).toHaveBeenCalled());
    });

    it('relevance chip on gated frameworks toggles setRelevance', () => {
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        const dora = screen.getByTestId('fw-card-dora').querySelector('[data-testid="fw-relevance"]');
        expect(dora.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(dora);
        expect(props.data.frameworks.setRelevance).toHaveBeenCalledWith('dora', 'relevant');
        // machinery is gated too, but locked cards show the lock footer instead
        expect(screen.getByTestId('fw-card-machinery').querySelector('[data-testid="fw-relevance"]')).toBeNull();
        expect(screen.getByTestId('fw-card-cra').querySelector('[data-testid="fw-relevance"]')).toBeNull();
    });

    it('the calendar card renders the full variant with a today divider; the own-framework card opens the custom page', () => {
        const props = pageProps();
        render(<FrameworksPage {...props} />);
        expect(screen.getByTestId('cal-today')).toBeTruthy();
        expect(screen.getAllByTestId('cal-row').length).toBe(3);
        fireEvent.click(screen.getByTestId('fw-card-own'));
        expect(props.navigate).toHaveBeenCalledWith('custom');
        expect(props.setHeaderActions).toHaveBeenCalledWith(expect.objectContaining({ onAddFramework: expect.any(Function) }));
    });

    it('the AI Act card scores 58 in error tone and marks Art. 50 missed only when the disclosure check fails', () => {
        const failing = [{ check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', article: '50', status: 'fail' }];
        const { unmount } = render(<FrameworksPage {...pageProps({ checks: failing })} />);
        expect(screen.getByTestId('aia-phases-card-score').textContent).toBe('58');
        expect(screen.getByTestId('aia-phases-card-score').dataset.tone).toBe('error');
        let states = [...screen.getAllByTestId('aia-phases-card-timeline-phase')].map(el => el.dataset.state);
        expect(states).toEqual(['done', 'missed', 'upcoming', 'future']);
        unmount();

        render(<FrameworksPage {...pageProps({ checks: [] })} />);
        states = [...screen.getAllByTestId('aia-phases-card-timeline-phase')].map(el => el.dataset.state);
        expect(states).toEqual(['done', 'done', 'upcoming', 'future']);
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

describe('FrameworksPage — other tabs', () => {
    it('calendar tab renders the calendar full width and nothing else', () => {
        render(<FrameworksPage {...pageProps({ tab: 'calendar' })} />);
        expect(screen.getByTestId('frameworks-page-calendar')).toBeTruthy();
        expect(screen.getByTestId('cal-today')).toBeTruthy();
        expect(screen.queryByTestId('fw-grid')).toBeNull();
    });

    it('per_automation tab lists GET /ai-act/assessments and the row action calls onOpenLadder(kind, id)', async () => {
        fetchJson.mockResolvedValueOnce([
            { target_kind: 'automation', target_id: 'a1', title: 'Intake bot', outcome: 'transparency', attested_at: '2026-06-01T00:00:00Z', expires_at: '2027-06-01T00:00:00Z', current: true },
            { target_kind: 'agent', target_id: 'g1', title: null, outcome: 'not_applicable', attested_at: '2025-01-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z', current: false },
        ]);
        const onOpenLadder = vi.fn();
        render(<FrameworksPage {...pageProps({ tab: 'per_automation', props: { onOpenLadder } })} />);
        await waitFor(() => expect(screen.getAllByTestId('fw-per-automation-row').length).toBe(2));
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/ai-act\/assessments$/);
        const pills = screen.getAllByTestId('fw-per-automation-outcome');
        expect(pills[0].textContent).toBe('Art. 4 + Art. 50');
        expect(pills[0].dataset.tone).toBe('warning');
        const buttons = screen.getAllByTestId('fw-per-automation-open');
        expect(buttons[1].textContent).toBe('Reassess');
        fireEvent.click(buttons[0]);
        expect(onOpenLadder).toHaveBeenCalledWith('automation', 'a1', 'Intake bot');
    });

    it('per_automation on a phone: the card list, same outcome pill and ladder action', async () => {
        fetchJson.mockResolvedValueOnce([
            { target_kind: 'automation', target_id: 'a1', title: 'Intake bot', outcome: 'transparency', attested_at: '2026-06-01T00:00:00Z', expires_at: '2027-06-01T00:00:00Z', current: true },
        ]);
        const onOpenLadder = vi.fn();
        render(<FrameworksPage {...pageProps({ tab: 'per_automation', props: { onOpenLadder, isMobile: true } })} />);
        await waitFor(() => expect(screen.getAllByTestId('fw-per-automation-card').length).toBe(1));
        expect(screen.getByTestId('fw-per-automation-table').dataset.view).toBe('cards');
        expect(screen.queryAllByTestId('fw-per-automation-row').length).toBe(0);
        const card = screen.getByTestId('fw-per-automation-card');
        expect(card.textContent).toMatch(/Intake bot/);
        expect(screen.getByTestId('fw-per-automation-outcome').textContent).toBe('Art. 4 + Art. 50');
        const open = screen.getByTestId('fw-per-automation-open');
        expect(open.className).toMatch(/min-h-\[44px\]/);
        fireEvent.click(open);
        expect(onOpenLadder).toHaveBeenCalledWith('automation', 'a1', 'Intake bot');
    });

    it('per_automation: a 404 (endpoint not shipped) is a failed state, not an empty table', async () => {
        fetchJson.mockRejectedValueOnce(new Error('HTTP 404'));
        render(<FrameworksPage {...pageProps({ tab: 'per_automation' })} />);
        await waitFor(() => expect(screen.getByTestId('fw-per-automation-failed')).toBeTruthy());
    });
});

describe('pure helpers', () => {
    it('statusChipOf / enableIsPrimary / phaseStates / disclosureFails / frameworkIcon', () => {
        expect(statusChipOf({ in_force_since: '2025-01-01' }, NOW).tone).toBe('success');
        expect(statusChipOf({ in_force_from: '2026-10-01' }, NOW)).toMatchObject({ tone: 'warning', days: 17 });
        expect(statusChipOf({ in_force_from: '2027-06-01' }, NOW).tone).toBe('neutral');
        expect(statusChipOf({}, NOW)).toBeNull();
        expect(enableIsPrimary({ recently_in_force: true })).toBe(true);
        expect(enableIsPrimary({ relevance: 'relevant' })).toBe(true);
        expect(enableIsPrimary({ relevance: 'unknown' })).toBe(false);
        const phases = phaseStates([{ date: '2026-08-02', label_key: 'x_art50' }, { date: '2026-09-30', label_key: 'y' }, { date: 'nope' }], { now: NOW, art50Missed: true });
        expect(phases.map(p => p.state)).toEqual(['missed', 'upcoming']);
        expect(phases[1].daysLeft).toBe(16);
        expect(disclosureFails([{ regulation: 'AIA', article: '50(2)', status: 'fail' }])).toBe(true);
        expect(disclosureFails([{ regulation: 'GDPR', article: '50', status: 'fail' }])).toBe(false);
        expect(disclosureFails(null)).toBe(false);
        expect(frameworkIcon('data_act')).toBe(frameworkIcon('DATA-ACT'));
        expect(frameworkIcon('unknown')).toBe(frameworkIcon(null));
    });
});
