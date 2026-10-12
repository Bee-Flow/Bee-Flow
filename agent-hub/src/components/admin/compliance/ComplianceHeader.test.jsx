import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ComplianceHeader, { headerSpec, HEADER_SPECS, worstScore } from './ComplianceHeader';
import { sectionById } from './sections';
import { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';

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
const noDownloads = () => null;

describe('ComplianceHeader — overview and frameworks', () => {
    it('overview: "{n} open" pill, last-run chip, report link, "Run now" primary in PRIMARY_ACTION_STYLE', async () => {
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts, core, dl, api: '/api/compliance' }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent(/^7 open$/);
        expect(screen.getByTestId('header-info')).toHaveTextContent(/Last run \d{2}:\d{2} · every 6 h/);
        expect(screen.getByTestId('header-secondary')).toHaveAttribute('href', '/api/compliance/report.pdf');
        const primary = screen.getByTestId('header-primary');
        expect(primary).toHaveTextContent('Run now');
        expect(primary.style.background).toBe(PRIMARY_ACTION_STYLE.background);
        expect(primary.getAttribute('style')).not.toMatch(/var\(--text-primary\)/);
        await userEvent.click(primary);
        expect(core.runNow).toHaveBeenCalled();
    });

    it('overview: the pill tone is the worst of ALL frameworks (DORA too), with a check only when all is green', () => {
        const green = { ...counts, frameworks: { gdpr: { score: 95 }, aia: { score: 92 }, iso27001: { score: 94 } } };
        const { unmount } = render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts: green, core }} />);
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'success');
        expect(screen.getByTestId('header-pill').querySelector('svg')).toHaveClass('lucide-circle-check');
        unmount();
        // The three core frameworks are green; an enabled DORA at 58 is not.
        const dora = { ...green, frameworks: { ...green.frameworks, dora: { score: 58 } } };
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts: dora, core }} />);
        expect(screen.getByTestId('header-pill')).not.toHaveAttribute('data-tone', 'success');
        expect(screen.getByTestId('header-pill').querySelector('svg')).toHaveClass('lucide-triangle-alert');
        expect(worstScore(dora)).toBe(58);
        expect(worstScore(null)).toBeUndefined();
        expect(worstScore({ frameworks: {} })).toBeUndefined();
    });

    it('overview before setup: neutral setup pill, primary disabled', () => {
        const c = { ...core, onboarded: false, overview: { onboarded: false } };
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts: { setup_step: 2 }, core: c, dl, api: '/x' }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Setup · step 2 of 4');
        expect(screen.getByTestId('header-primary')).toBeDisabled();
    });

    it('with downloads off there is no report button at all, never a dead one', () => {
        render(<ComplianceHeader section={sectionById('overview')} tab="status" onTab={vi.fn()} ctx={{ counts, core, dl: noDownloads, api: '/x' }} />);
        expect(screen.queryByTestId('header-secondary')).toBeNull();
        expect(screen.queryByText('Report (PDF)')).toBeNull();
        expect(headerSpec({ section: sectionById('overview'), counts, core, dl: noDownloads, api: '/x' }, t).secondary).toBeNull();
    });

    it('a framework section: score pill from counts, checks tab count, "Run again", and no report download', () => {
        render(<ComplianceHeader section={sectionById('gdpr')} tab="checks" onTab={vi.fn()} ctx={{ counts, core, dl, api: '/x', frameworks: { byId: () => ({ in_force_since: '2018-05-25' }) } }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('79 · A few items need attention');
        expect(screen.getByTestId('header-info')).toHaveTextContent('In force since 2018-05-25');
        expect(screen.getByTestId('header-primary')).toHaveTextContent('Run again');
        expect(screen.getByRole('radio', { name: /checks/i })).toHaveTextContent('2');
        // The org-wide report lives in the Overview header, Reports and the rail.
        expect(screen.queryByTestId('header-secondary')).toBeNull();
        expect(screen.queryByText('Report (PDF)')).toBeNull();
    });

    it('the info chip is quiet text, and its folded icon is a focusable tooltip trigger with the full text', async () => {
        render(<ComplianceHeader section={sectionById('incidents')} tab={null} onTab={vi.fn()} ctx={{ counts: {} }} />);
        const chip = screen.getByTestId('header-info');
        // No box: nothing that makes a static reference look like a button.
        expect(chip.className).not.toMatch(/\bborder\b|\bh-8\b|bg-\[var\(--bg-card\)\]/);
        expect(chip.className).toContain('text-[var(--text-tertiary)]');
        const trigger = screen.getByRole('button', { name: 'Art. 33 · 72 hours to the authority' });
        expect(trigger.closest('span.hidden').className).toContain('@max-[1180px]/objhead:inline-flex');
        await userEvent.tab();
        expect(trigger).toHaveFocus();
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Art. 33 · 72 hours to the authority');
    });

});

describe('ComplianceHeader — register sections', () => {
    it('unknown counts → no pill, no tab badge (never a 0)', () => {
        const spec = headerSpec({ section: sectionById('gdpr'), counts: null, core: { ...core, checks: [] }, dl, api: '/x' }, t);
        expect(spec.pill).toBeNull();
        expect(spec.tabCounts.checks).toBeUndefined();
        const soa = headerSpec({ section: sectionById('soa'), counts: null, soa: { soa: null }, dl, api: '/x' }, t);
        expect(soa.pill).toBeNull();
        const overview = headerSpec({ section: sectionById('overview'), counts: null, core }, t);
        expect(overview.pill).toBeNull();
    });

    it('dsr: overdue pill in error tone, window chip, the capture primary only when the page registered it', () => {
        const withAction = headerSpec({ section: sectionById('dsr'), counts, dsr: { requests: [{}, {}], refresh: vi.fn() }, onCaptureRequest: vi.fn(), dl }, t);
        expect(withAction.primary).not.toBeNull();
        expect(withAction.tabCounts.requests).toBe(2);
        const without = headerSpec({ section: sectionById('dsr'), counts, dsr: { requests: null }, dl }, t);
        expect(without.primary).toBeNull();
        expect(without.secondary).toBeNull();
        render(<ComplianceHeader section={sectionById('dsr')} tab="requests" onTab={vi.fn()} ctx={{ counts, dsr: { requests: [], refresh: vi.fn() }, dl }} />);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('1 past the deadline');
        expect(screen.getByTestId('header-pill').getAttribute('style')).toMatch(/--error/);
    });

    it('incidents: the pill names the next stage and its hours, toned by the rail\'s urgency rule', () => {
        const at = (hours, stage = 'authority', open = 2) => headerSpec({ section: sectionById('incidents'), counts: { incidents: { open, hours_left: hours, next_stage: stage } } }, t).pill;
        const { rerender } = render(at(40));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('2 open · authority notice in 40 h');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'neutral');
        rerender(at(5, 'early_warning'));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('2 open · early warning in 5 h');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'warning');
        rerender(at(-3, 'final_report'));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('2 open · final report 3 h overdue');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'error');
        rerender(at(10, 'customer_notice'));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('customer notice in 10 h');
        // An older server without a stage keeps the plain clock wording.
        rerender(at(30, null));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('2 open · 30 h to the deadline');
        rerender(at(null, null, 0));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('No incident running');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'neutral');
    });

});

describe('ComplianceHeader — layout and tabs', () => {
    it('layout="phone": the title bar keeps tile, title and tab menu; a second row holds every action', async () => {
        const onSeed = vi.fn();
        render(<ComplianceHeader layout="phone" section={sectionById('risks')} tab={null} onTab={vi.fn()}
            ctx={{ counts: { risks: { total: 7, high: 2 } }, onAddRisk: vi.fn(), onSeedRisks: onSeed }} />);
        const bar = screen.getByTestId('compliance-header-bar');
        expect(within(bar).getByTestId('studio-section-title')).toHaveTextContent('Risk register');
        expect(within(bar).queryByTestId('header-primary')).toBeNull();
        expect(within(bar).queryByTestId('header-pill')).toBeNull();
        const row = screen.getByTestId('compliance-header-actions');
        expect(row.className).toContain('flex-wrap');
        for (const id of ['header-pill', 'header-info', 'header-secondary', 'header-primary']) expect(within(row).getByTestId(id)).toBeInTheDocument();
        expect(within(row).getByTestId('header-primary')).toHaveTextContent('Add risk');
        await userEvent.click(within(row).getByRole('button', { name: 'Seed suggested risks' }));
        expect(onSeed).toHaveBeenCalled();
    });

    it('layout="phone" with tabs: the tab menu sits in the bar', () => {
        render(<ComplianceHeader layout="phone" section={sectionById('gdpr')} tab="checks" onTab={vi.fn()} ctx={{ counts, core }} />);
        expect(within(screen.getByTestId('compliance-header-bar')).getByTestId('studio-section-tab-menu')).toBeInTheDocument();
        expect(within(screen.getByTestId('compliance-header-actions')).getByTestId('header-primary')).toHaveTextContent('Run again');
    });

    it('tab clicks call onTab with the id; a section without tabs renders no strip', async () => {
        const onTab = vi.fn();
        render(<ComplianceHeader section={sectionById('soa')} tab="controls" onTab={onTab} ctx={{ counts, dl, api: '/x' }} />);
        await userEvent.click(screen.getByRole('radio', { name: /history/i }));
        expect(onTab).toHaveBeenCalledWith('history');
        render(<ComplianceHeader section={sectionById('incidents')} tab={null} onTab={onTab} ctx={{}} />);
        expect(screen.queryByRole('radio', { name: /incidents/i })).toBeNull();
    });

    it('asks StudioSectionHeader for the compact tab fold and a title that never collapses', () => {
        render(<ComplianceHeader section={sectionById('audits')} tab="audits" onTab={vi.fn()} ctx={{}} />);
        expect(screen.getByRole('radiogroup').closest('div.flex-shrink-0').className).toContain('@max-[900px]/objhead:hidden');
        expect(screen.getByTestId('studio-section-title').parentElement.className).toMatch(/^shrink-0 /);
        expect(screen.getByTestId('studio-section-title')).toHaveTextContent('Audits & reviews');
    });

    it('HEADER_SPECS is the extension point page streams add to', () => {
        expect(Object.keys(HEADER_SPECS)).toEqual(expect.arrayContaining(['overview', 'frameworks', 'dsr', 'soa', 'ropa', 'portability', 'custom', 'machinery', 'training']));
    });
});
