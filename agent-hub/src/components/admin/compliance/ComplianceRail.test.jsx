import { render, screen, fireEvent } from '@testing-library/react';
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
    risks: { total: 12, high: 2 }, soa: { approved: 9, total: 93 }, policies: { total: 6, review_due: 1 },
    audits: { planned: 1 }, training: { done: 41, total: 44 }, connectors: { count: 3 },
    evidence: { rows: 2053, chain_ok: true, algorithm: 'SHA-256' },
};

describe('ComplianceRail', () => {
    it('renders head, groups, every non-optional row with a title, and the chain footer', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} onOpenReports={vi.fn()} counts={COUNTS} orgName="Van Dijk Groep" />);
        expect(screen.getByText('Compliance')).toBeInTheDocument();
        expect(screen.getByText('Van Dijk Groep · Compliance Hub')).toBeInTheDocument();
        for (const s of SECTIONS.filter(x => !x.optional)) expect(screen.getByTitle(s.labelFallback)).toBeInTheDocument();
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
        expect(screen.getByTestId('rail-row-soa')).toHaveTextContent('9/93 approved');
        expect(screen.getByTestId('rail-row-gdpr')).toHaveTextContent('79');
        expect(screen.getByTestId('rail-row-dsr')).toHaveTextContent('4 open');
        unmount();
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={null} />);
        expect(screen.queryAllByTestId('rail-meta')).toHaveLength(1); // only the static settings hint
        expect(screen.queryByTestId('compliance-rail-chain')).toBeNull();
    });

    it('"Needs attention" filters to rows with something open; the badge carries the count', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} counts={COUNTS} />);
        expect(hasOpenItem({ id: 'gdpr' }, COUNTS)).toBe(true);
        expect(hasOpenItem({ id: 'iso' }, COUNTS)).toBe(false);
        expect(hasOpenItem({ id: 'soa' }, COUNTS)).toBe(true);
        fireEvent.click(screen.getByRole('radio', { name: /Needs attention/ }));
        expect(screen.queryByTestId('rail-row-iso')).toBeNull();
        expect(screen.getByTestId('rail-row-gdpr')).toBeInTheDocument();
        expect(screen.getByTestId('rail-row-overview')).toBeInTheDocument();
    });

    it('search filters rows and, from two characters, lists matching checks that navigate to their framework', () => {
        const onSelect = vi.fn();
        const checks = [{ check_id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', article: '28', titleKey: 'compliance.x' }];
        render(<ComplianceRail active="overview" onSelect={onSelect} counts={COUNTS} checks={checks} />);
        fireEvent.change(screen.getByTestId('compliance-rail-search'), { target: { value: 'Art28' } });
        const hit = screen.getByTestId('compliance-rail-check-hit');
        fireEvent.click(hit);
        expect(onSelect).toHaveBeenCalledWith('GDPR', 'GDPR-Art28-subprocessors');
        fireEvent.change(screen.getByTestId('compliance-rail-search'), { target: { value: 'risk' } });
        expect(screen.getByTestId('rail-row-risks')).toBeInTheDocument();
        expect(screen.queryByTestId('rail-row-soa')).toBeNull();
    });

    it('hides the download icon when exports are off', () => {
        render(<ComplianceRail active="overview" onSelect={vi.fn()} onOpenReports={vi.fn()} counts={COUNTS} exportsEnabled={false} />);
        expect(screen.queryByTestId('compliance-rail-download')).toBeNull();
    });
});
