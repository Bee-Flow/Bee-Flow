import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ComplianceRail, { visibleSections, hasOpenItem } from './ComplianceRail';
import { SECTIONS } from './sections';

vi.mock('../../../hooks/useTranslation', () => {
    const t = (key, fallback, vars) => {
        let s = typeof fallback === 'string' ? fallback : key;
        for (const [k, v] of Object.entries((typeof fallback === 'object' ? fallback : vars) || {})) s = s.replace(`{${k}}`, String(v));
        return s;
    };
    return { useTranslation: () => ({ t }), default: () => ({ t }) };
});

const COUNTS = {
    attention_open: 7,
    last_run: { at: '2026-09-14T07:12:00Z' },
    frameworks: { gdpr: { score: 79 }, aia: { score: 58 }, iso27001: { score: 88 }, cra: { score: 40 } },
    frameworks_summary: { candidates: 7, recently_in_force: 2 },
    dsr: { open: 4, overdue: 1 }, incidents: { open: 1, hours_left: 41 }, dpia: { todo: 2 },
    risks: { total: 12, high: 2 }, soa: { approved: 9, total: 93, todo: 61 }, policies: { total: 6, review_due: 1 },
    audits: { planned: 1 }, training: { done: 41, total: 44 }, connectors: { count: 3 },
    evidence: { rows: 2053, chain_ok: true, algorithm: 'SHA-256' },
};

describe('ComplianceRail', () => {
    it('renders head, groups, every non-optional row with a title, and the chain footer', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} onOpenReports={vi.fn()} counts={COUNTS} orgName="Van Dijk Groep" />);
        expect(screen.getByText('Compliance')).toBeInTheDocument();
        expect(screen.getByText('Van Dijk Groep · Compliance Hub')).toBeInTheDocument();
        // The title is the label, plus the row's hint on a second line when it has one.
        for (const s of SECTIONS.filter(x => !x.optional)) {
            expect(screen.getByTestId(`rail-row-${s.id}`).getAttribute('title').split('\n')[0]).toBe(s.labelFallback);
        }
        expect(screen.getByText('Frameworks')).toBeInTheDocument();
        expect(screen.getByText('Registers')).toBeInTheDocument();
        expect(screen.getByText('Admin')).toBeInTheDocument();
        expect(screen.getByTestId('compliance-rail-chain')).toHaveTextContent('Evidence chain intact · 2,053 rows · SHA-256');
    });

    it('optional framework rows appear only when the org has them (counts or enabled), registers follow their framework', () => {
        const withCra = visibleSections(SECTIONS, { counts: COUNTS, frameworks: null }).map(s => s.id);
        expect(withCra).toContain('cra');
        expect(withCra).toContain('vulnerabilities');
        expect(withCra).not.toContain('nis2');
        expect(withCra).not.toContain('portability');
        const enabled = visibleSections(SECTIONS, { counts: null, frameworks: { isEnabled: (id) => id === 'data_act' } }).map(s => s.id);
        expect(enabled).toContain('data_act');
        expect(enabled).toContain('portability');
        expect(enabled).not.toContain('cra');
    });

    it('the active row is a raised card with aria-current and NO accent bar; a click emits the id', () => {
        const onSelect = vi.fn();
        render(<ComplianceRail active="soa" onSelect={onSelect} counts={COUNTS} />);
        const row = screen.getByTestId('rail-row-soa');
        expect(row).toHaveAttribute('aria-current', 'page');
        expect(row.className).toMatch(/bg-\[var\(--bg-card\)\]/);
        expect(row.className).not.toMatch(/border-l/);
        expect(row.getAttribute('style') || '').not.toMatch(/inset 3px/);
        fireEvent.click(screen.getByTestId('rail-row-dsr'));
        expect(onSelect).toHaveBeenCalledWith('dsr');
    });

    it('shows meta from counts and none when counts are absent', () => {
        const { unmount } = render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={COUNTS} />);
        expect(screen.getByTestId('rail-row-soa')).toHaveTextContent('61 to decide');
        expect(screen.getByTestId('rail-row-gdpr')).toHaveTextContent('79');
        expect(screen.getByTestId('rail-row-dsr')).toHaveTextContent('4 open');
        unmount();
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={null} />);
        expect(screen.queryAllByTestId('rail-meta')).toHaveLength(0);
        expect(screen.queryByTestId('compliance-rail-chain')).toBeNull();
    });

    it('"Needs attention" filters to rows with something open; the badge carries the count', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={COUNTS} checks={null} />);
        // Checks not loaded yet: the score decides.
        expect(hasOpenItem({ id: 'gdpr' }, COUNTS)).toBe(true);
        expect(hasOpenItem({ id: 'iso' }, COUNTS)).toBe(false);
        expect(hasOpenItem({ id: 'soa' }, COUNTS)).toBe(true);
        fireEvent.click(screen.getByRole('radio', { name: /Needs attention/ }));
        expect(screen.queryByTestId('rail-row-iso')).toBeNull();
        expect(screen.getByTestId('rail-row-gdpr')).toBeInTheDocument();
        expect(screen.getByTestId('rail-row-overview')).toBeInTheDocument();
    });

    it('search filters rows and, from two characters, lists matching checks that open the section scoring them', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const checks = [{ check_id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', article: '28', titleKey: 'compliance.x' }];
        render(<ComplianceRail active="overview" onSelect={onSelect} counts={COUNTS} checks={checks} />);
        await user.type(screen.getByTestId('compliance-rail-search'), 'Art28');
        await user.click(screen.getByTestId('compliance-rail-check-hit'));
        expect(onSelect).toHaveBeenCalledWith('gdpr', 'GDPR-Art28-subprocessors');
        expect(screen.getByTestId('compliance-rail-check-ref')).toHaveTextContent('GDPR Art. 28');
        await user.clear(screen.getByTestId('compliance-rail-search'));
        await user.type(screen.getByTestId('compliance-rail-search'), 'risk');
        expect(screen.getByTestId('rail-row-risks')).toBeInTheDocument();
        expect(screen.queryByTestId('rail-row-soa')).toBeNull();
    });

    it('hides the download icon when exports are off', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} onOpenReports={vi.fn()} counts={COUNTS} exportsEnabled={false} />);
        expect(screen.queryByTestId('compliance-rail-download')).toBeNull();
    });
});

describe('ComplianceRail — round 2: hints, open checks, check search', () => {
    it('Settings and Connectors show no meta; hovering or focusing the row reads the former text', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={COUNTS} />);
        for (const id of ['settings', 'connectors', 'overview']) {
            const row = screen.getByTestId(`rail-row-${id}`);
            expect(within(row).queryByTestId('rail-meta'), id).toBeNull();
            // Tooltip: label + hint. Description: the sr-only hint, outside the button.
            const hint = screen.getByTestId(`rail-hint-${id}`);
            expect(row.getAttribute('title')).toBe(`${row.textContent}\n${hint.textContent}`);
            expect(row).toHaveAccessibleDescription(hint.textContent);
            expect(row.contains(hint)).toBe(false);
        }
        expect(screen.getByTestId('rail-hint-settings')).toHaveTextContent('DPO · legal bases');
        expect(screen.getByTestId('rail-hint-connectors')).toHaveTextContent(/^3$/);
        // A row without a hint has no description.
        expect(screen.getByTestId('rail-row-dsr')).not.toHaveAttribute('aria-describedby');
    });

    it('the attention filter keeps GDPR with a failing check while its score is 95, and shows the open count', async () => {
        const user = userEvent.setup();
        const counts = { ...COUNTS, frameworks: { gdpr: { score: 95 }, aia: { score: 58 }, iso27001: { score: 94 } } };
        const checks = [
            { check_id: 'GDPR-Art35-dpia', regulation: 'GDPR', status: 'fail' },
            { check_id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', status: 'warn' },
            { check_id: 'GDPR-Art32-dlp', regulation: 'GDPR', status: 'pass' },
            { check_id: 'ISO27001-A.5.20-suppliers', regulation: 'ISO27001', status: 'fail' },
            { check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', status: 'pass' },
        ];
        expect(hasOpenItem({ id: 'gdpr' }, counts, checks)).toBe(true);
        expect(hasOpenItem({ id: 'iso' }, counts, checks)).toBe(true);
        // Loaded checks win over the score: AI Act at 58 with nothing open is clean.
        expect(hasOpenItem({ id: 'aia' }, counts, checks)).toBe(false);
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={counts} checks={checks} />);
        expect(screen.getByTestId('rail-row-gdpr')).toHaveTextContent('95');
        await user.click(screen.getByRole('radio', { name: /Needs attention/ }));
        expect(screen.getByTestId('rail-row-gdpr')).toHaveTextContent('2 to fix');
        expect(screen.getByTestId('rail-row-iso')).toHaveTextContent('1 to fix');
        expect(screen.queryByTestId('rail-row-aia')).toBeNull();
    });

    it('"Art. 50" finds the AI Act marking check once, with its subject count', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const marking = { check_id: 'AIA-Art50-content-marking', regulation: 'AIA', article: '50(2)', titleKey: 'Machine-readable marking' };
        const checks = [
            { ...marking, scope_id: 'auto_1', status: 'fail' },
            { ...marking, scope_id: 'auto_2', status: 'pass' },
            { check_id: 'GDPR-Art5-x', regulation: 'GDPR', article: '5', titleKey: 'Principles' },
        ];
        render(<ComplianceRail active="overview" onSelect={onSelect} counts={COUNTS} checks={checks} />);
        await user.type(screen.getByTestId('compliance-rail-search'), 'Art. 50');
        const hits = screen.getAllByTestId('compliance-rail-check-hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toHaveTextContent('AIA-Art50-content-marking'); // the mock t falls back to the id
        expect(within(hits[0]).getByTestId('compliance-rail-check-scopes')).toHaveTextContent('· 2');
        expect(within(hits[0]).getByTestId('compliance-rail-check-ref')).toHaveTextContent('AI Act Art. 50(2)');
        await user.click(hits[0]);
        expect(onSelect).toHaveBeenCalledWith('aia', 'AIA-Art50-content-marking');
    });
});
