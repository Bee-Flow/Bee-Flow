import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ComplianceHeader, { headerSpec, HEADER_SPECS } from './ComplianceHeader';
import { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';
import { sectionById } from './sections';

vi.mock('../../../hooks/useTranslation', () => {
    const t = (key, fallback, vars) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries((typeof fallback === 'object' ? fallback : vars) || {})) s = s.replace(`{${k}}`, String(v));
        return s;
    };
    return { useTranslation: () => ({ t }), default: () => ({ t }) };
});

const t = (key, fallback, vars) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries((typeof fallback === 'object' ? fallback : vars) || {})) s = s.replace(`{${k}}`, String(v));
    return s;
};

const core = { overview: { onboarded: true, last_run_at: '2026-09-14T07:12:00Z' }, onboarded: true, running: false, runNow: vi.fn(), checks: [{ regulation: 'GDPR' }, { regulation: 'GDPR' }, { regulation: 'AIA' }] };
const counts = { attention_open: 7, last_run: { at: '2026-09-14T07:12:00Z', interval_hours: 6 }, frameworks: { gdpr: { score: 79 }, aia: { score: 58 }, iso27001: { score: 88 } }, soa: { approved: 9, total: 93 }, dsr: { overdue: 1 } };
const dl = (u) => u;

describe('ComplianceHeader', () => {
    it('overview: worst-score pill with the open count, last-run chip, report link, "Run now" primary in PRIMARY_ACTION_STYLE', () => {
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts, core, dl, api: '/api/compliance' }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Clear gaps · 7 open');
        expect(screen.getByTestId('header-info')).toHaveTextContent(/Last run \d{2}:\d{2} · every 6 h/);
        expect(screen.getByTestId('header-secondary')).toHaveAttribute('href', '/api/compliance/report.pdf');
        const primary = screen.getByTestId('header-primary');
        expect(primary).toHaveTextContent('Run now');
        expect(primary.style.background).toBe(PRIMARY_ACTION_STYLE.background);
        expect(primary.getAttribute('style')).not.toMatch(/var\(--text-primary\)/);
        fireEvent.click(primary);
        expect(core.runNow).toHaveBeenCalled();
    });

    it('overview before setup: neutral setup pill, primary disabled', () => {
        const c = { ...core, onboarded: false, overview: { onboarded: false } };
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts: { setup_step: 2 }, core: c, dl, api: '/x' }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Setup · step 2 of 4');
        expect(screen.getByTestId('header-primary')).toBeDisabled();
    });

    it('a framework section: score pill from counts, checks tab count, "Run again"', () => {
        render(<ComplianceHeader section={sectionById('gdpr')} tab="checks" onTab={vi.fn()} ctx={{ counts, core, dl, api: '/x', frameworks: { byId: () => ({ in_force_since: '2018-05-25' }) } }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('79 · A few items need attention');
        expect(screen.getByTestId('header-info')).toHaveTextContent('In force since 2018-05-25');
        expect(screen.getByTestId('header-primary')).toHaveTextContent('Run again');
        expect(screen.getByRole('radio', { name: /checks/i })).toHaveTextContent('2');
    });

    it('unknown counts → no pill, no tab badge (never a 0)', () => {
        const spec = headerSpec({ section: sectionById('gdpr'), counts: null, core: { ...core, checks: [] }, dl, api: '/x' }, t);
        expect(spec.pill).toBeNull();
        expect(spec.tabCounts.checks).toBeUndefined();
        const soa = headerSpec({ section: sectionById('soa'), counts: null, soa: { soa: null }, dl, api: '/x' }, t);
        expect(soa.pill).toBeNull();
    });

    it('dsr: overdue pill in error tone, window chip, the capture primary only when the page registered it', () => {
        const withAction = headerSpec({ section: sectionById('dsr'), counts, dsr: { requests: [{}, {}], refresh: vi.fn() }, onCaptureRequest: vi.fn(), dl }, t);
        expect(withAction.primary).not.toBeNull();
        expect(withAction.tabCounts.requests).toBe(2);
        const without = headerSpec({ section: sectionById('dsr'), counts, dsr: { requests: null }, dl }, t);
        expect(without.primary).toBeNull();
        render(<ComplianceHeader section={sectionById('dsr')} tab="requests" onTab={vi.fn()} ctx={{ counts, dsr: { requests: [], refresh: vi.fn() }, dl }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('1 past the deadline');
        expect(screen.getByTestId('header-pill').getAttribute('style')).toMatch(/--error/);
    });

    it('tab clicks call onTab with the id; a section without tabs renders no strip', () => {
        const onTab = vi.fn();
        render(<ComplianceHeader section={sectionById('soa')} tab="controls" onTab={onTab} ctx={{ counts, dl, api: '/x' }} />);
        fireEvent.click(screen.getByRole('radio', { name: /history/i }));
        expect(onTab).toHaveBeenCalledWith('history');
        render(<ComplianceHeader section={sectionById('incidents')} tab={null} onTab={onTab} ctx={{}} />);
        expect(screen.queryByRole('radio', { name: /incidents/i })).toBeNull();
    });

    it('HEADER_SPECS is the extension point page streams add to', () => {
        expect(Object.keys(HEADER_SPECS)).toEqual(expect.arrayContaining(['overview', 'frameworks', 'dsr', 'soa']));
    });
});
