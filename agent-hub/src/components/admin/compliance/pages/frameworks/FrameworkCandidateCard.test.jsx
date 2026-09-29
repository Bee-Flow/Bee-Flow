import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import FrameworkCandidateCard, { OwnFrameworkCard, statusChipOf, enableIsPrimary } from './FrameworkCandidateCard';
import { frameworkIcon, FRAMEWORK_ICONS } from './frameworkIcons';

vi.mock('../../../../../hooks/useTranslation', () => {
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

const base = (over = {}) => ({
    id: 'cra',
    name_key: 'compliance.fw_cra_name',
    name: 'CRA',
    description_key: 'compliance.fw_cra_desc',
    affects_key: 'compliance.fw_cra_affects',
    in_force_since: '2026-09-11',
    checks_count: 3,
    registers: ['vulnerabilities'],
    calendar_count: 2,
    enabled: false,
    core: false,
    locked: null,
    relevance: 'unknown',
    ...over,
});

describe('FrameworkCandidateCard — locked', () => {
    it('a ceiling lock shows the upgrade hint, the plan link, and NO enable button', () => {
        const onViewPlan = vi.fn();
        const onEnable = vi.fn();
        render(<FrameworkCandidateCard framework={base({ id: 'nis2', locked: 'ceiling' })} now={NOW} onEnable={onEnable} onViewPlan={onViewPlan} />);
        const card = screen.getByTestId('fw-card-nis2');
        expect(card.dataset.locked).toBe('ceiling');
        expect(screen.getByTestId('fw-locked').textContent).toContain('Available on a higher plan');
        expect(screen.queryByTestId('fw-enable')).toBeNull();
        expect(screen.queryByTestId('fw-disable')).toBeNull();
        fireEvent.click(screen.getByTestId('fw-view-plan'));
        expect(onViewPlan).toHaveBeenCalledTimes(1);
        expect(onEnable).not.toHaveBeenCalled();
    });

    it('a not_granted lock names the admin, not the plan ceiling', () => {
        render(<FrameworkCandidateCard framework={base({ id: 'machinery', locked: 'not_granted' })} now={NOW} />);
        expect(screen.getByTestId('fw-locked').textContent).toContain('ask an admin');
        expect(screen.getByTestId('fw-view-plan')).toBeTruthy();
    });

    it('a locked+gated framework still shows no relevance chip — the lock footer replaces the whole row', () => {
        render(<FrameworkCandidateCard framework={base({ id: 'dora', locked: 'ceiling', relevance_gate: true })} now={NOW} />);
        expect(screen.queryByTestId('fw-relevance')).toBeNull();
    });
});

describe('FrameworkCandidateCard — enable / disable', () => {
    it('enable calls onEnable(id) with the primary recipe when the framework just came into force', () => {
        const onEnable = vi.fn();
        render(<FrameworkCandidateCard framework={base({ recently_in_force: true })} now={NOW} onEnable={onEnable} />);
        const btn = screen.getByTestId('fw-enable');
        expect(btn.dataset.primary).toBe('true');
        expect(btn.style.background).toBe('var(--accent-primary)');
        fireEvent.click(btn);
        expect(onEnable).toHaveBeenCalledWith('cra');
    });

    it('without a recency or relevance signal the enable button is the secondary recipe', () => {
        render(<FrameworkCandidateCard framework={base({ id: 'pld', in_force_since: null, in_force_from: '2026-12-09' })} now={NOW} />);
        const btn = screen.getByTestId('fw-enable');
        expect(btn.dataset.primary).toBe('false');
        expect(btn.style.background).toBe('');
    });

    it('busy disables both the enable button and the relevance chip', () => {
        render(<FrameworkCandidateCard framework={base({ id: 'dora', relevance_gate: true })} now={NOW} busy />);
        expect(screen.getByTestId('fw-card-dora').getAttribute('aria-busy')).toBe('true');
        expect(screen.getByTestId('fw-enable').disabled).toBe(true);
        expect(screen.getByTestId('fw-relevance').disabled).toBe(true);
    });

    it('an enabled framework shows the check count and a Disable button instead of Enable', () => {
        const onDisable = vi.fn();
        render(<FrameworkCandidateCard framework={base({ id: 'eaa', enabled: true, checks_count: 2 })} now={NOW} onDisable={onDisable} />);
        expect(screen.getByTestId('fw-enabled-meta').textContent).toBe('Enabled · 2 checks');
        expect(screen.queryByTestId('fw-enable')).toBeNull();
        fireEvent.click(screen.getByTestId('fw-disable'));
        expect(onDisable).toHaveBeenCalledWith('eaa');
    });

    it('the meta line names checks, registers and calendar dates, and omits the zeroes', () => {
        const { unmount } = render(<FrameworkCandidateCard framework={base()} now={NOW} />);
        expect(screen.getByTestId('fw-meta').textContent).toBe('3 checks · 1 registers · 2 calendar dates');
        unmount();
        render(<FrameworkCandidateCard framework={base({ registers: [], calendar_count: 0 })} now={NOW} />);
        expect(screen.getByTestId('fw-meta').textContent).toBe('3 checks');
    });
});

describe('FrameworkCandidateCard — relevance', () => {
    it('a gated framework marked not relevant is pressed and toggles back to relevant', () => {
        const onRelevance = vi.fn();
        render(<FrameworkCandidateCard framework={base({ id: 'dora', relevance: 'not_relevant', relevance_gate: true })} now={NOW} onRelevance={onRelevance} />);
        const chip = screen.getByTestId('fw-relevance');
        expect(chip.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(chip);
        expect(onRelevance).toHaveBeenCalledWith('dora', 'relevant');
    });

    it('an unmarked gated framework toggles to not_relevant', () => {
        const onRelevance = vi.fn();
        render(<FrameworkCandidateCard framework={base({ id: 'machinery', relevance: 'unknown', relevance_gate: true })} now={NOW} onRelevance={onRelevance} />);
        fireEvent.click(screen.getByTestId('fw-relevance'));
        expect(onRelevance).toHaveBeenCalledWith('machinery', 'not_relevant');
    });

    it('an ungated framework shows the meta line instead of a relevance chip', () => {
        render(<FrameworkCandidateCard framework={base()} now={NOW} />);
        expect(screen.queryByTestId('fw-relevance')).toBeNull();
        expect(screen.getByTestId('fw-meta')).toBeTruthy();
    });
});

describe('FrameworkCandidateCard — chips, copy and icons', () => {
    it('renders the affects line with its counts and the description', () => {
        render(<FrameworkCandidateCard framework={base({ affects: { automations: 3, agents: 0 } })} now={NOW} />);
        expect(screen.getByTestId('fw-affects-counts').textContent).toContain('3 automations');
        expect(screen.getByTestId('fw-affects-counts').textContent).not.toContain('agents');
    });

    it('no date at all → no status chip, and a missing framework renders nothing', () => {
        const { container, unmount } = render(<FrameworkCandidateCard framework={base({ in_force_since: null, in_force_from: null })} now={NOW} />);
        expect(screen.queryByTestId('fw-status-chip')).toBeNull();
        expect(container.querySelector('[data-framework]')).toBeTruthy();
        unmount();
        const { container: empty } = render(<FrameworkCandidateCard framework={null} />);
        expect(empty.innerHTML).toBe('');
    });

    it('statusChipOf follows the dates and enableIsPrimary the signals', () => {
        expect(statusChipOf({ in_force_since: '2026-09-11' }, NOW)).toMatchObject({ tone: 'success', tint: 14 });
        expect(statusChipOf({ in_force_from: '2026-12-09' }, NOW)).toMatchObject({ tone: 'warning', tint: 16, days: 86 });
        expect(statusChipOf({ in_force_from: '2027-01-20' }, NOW).tone).toBe('neutral');
        expect(statusChipOf(null)).toBeNull();
        expect(enableIsPrimary({ recently_in_force: true })).toBe(true);
        expect(enableIsPrimary({ relevance: 'relevant' })).toBe(true);
        expect(enableIsPrimary({})).toBe(false);
        expect(enableIsPrimary(null)).toBe(false);
    });

    it('frameworkIcons has an entry for every growing-set framework and one fallback', () => {
        for (const id of ['nis2', 'cra', 'data_act', 'pld', 'eaa', 'dora', 'machinery']) {
            expect(FRAMEWORK_ICONS[id]).toBeTruthy();
            expect(frameworkIcon(id)).toBe(FRAMEWORK_ICONS[id]);
        }
        expect(frameworkIcon('DATA-ACT')).toBe(FRAMEWORK_ICONS.data_act);
        expect(frameworkIcon('who-knows')).toBe(frameworkIcon(undefined));
    });
});

describe('OwnFrameworkCard', () => {
    it('is a dashed door that calls onOpen', () => {
        const onOpen = vi.fn();
        render(<OwnFrameworkCard onOpen={onOpen} />);
        const card = screen.getByTestId('fw-card-own');
        expect(card.className).toContain('border-dashed');
        fireEvent.click(card);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});
