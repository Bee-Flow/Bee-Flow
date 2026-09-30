import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CheckRow from './CheckRow';
import { checkColumns } from './ChecksTable';

const COLUMNS = checkColumns((k, en) => en);

const base = {
    check_id: 'GDPR-Art33-breach', regulation: 'GDPR', article: '33', status: 'fail', severity: 'high',
    verification: 'automated', titleKey: 'compliance.check_breach_title', details: 'No breach detector configured',
    remediationLink: 'admin/compliance/incidents',
    frameworks: [{ regulation: 'GDPR', ref: '33' }, { regulation: 'ISO27001', ref: 'A.5.24' }],
    run_at: new Date(2026, 8, 14, 9, 5).toISOString(),
};

function renderRow(check, props = {}) {
    return render(
        <div role="table">
            <CheckRow check={check} regulation="GDPR" columns={COLUMNS} testId="row" now={new Date(2026, 8, 14, 15).getTime()} {...props} />
        </div>,
    );
}

describe('CheckRow — one check in the framework table', () => {
    it('a failing row: error stripe, severity tag, the cross-framework line, the article, the verification chip and the last-run time', () => {
        renderRow(base, { onOpenLink: vi.fn(), onToggle: vi.fn() });
        const row = screen.getByTestId('row');
        expect(row.style.boxShadow).toBe('inset 3px 0 0 var(--error)');
        expect(row).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByTestId('row-severity')).toHaveAttribute('data-severity', 'high');
        expect(screen.getByTestId('row-severity').style.color).toBe('var(--error-ink)');
        expect(screen.getByTestId('row-also')).toHaveTextContent('also counts for');
        expect(screen.getByTestId('row-also-ref')).toHaveTextContent('ISO A.5.24');
        expect(screen.getByTestId('row-also-ref')).not.toHaveTextContent('GDPR');
        expect(screen.getByTestId('row-article')).toHaveTextContent('Art. 33');
        expect(screen.getByTestId('row-verification')).toHaveAttribute('data-verification', 'automated');
        expect(screen.getByTestId('row-last-run')).toHaveTextContent('09:05');
        expect(screen.getByText('No breach detector configured').className).toContain('truncate');
    });

    it('a passing row shows NO severity tag, a rerun button (spinning while rerunning) and no fix button', () => {
        const onRerun = vi.fn();
        const { rerender } = renderRow({ ...base, status: 'pass' }, { onRerun, onOpenLink: vi.fn() });
        expect(screen.queryByTestId('row-severity')).toBeNull();
        expect(screen.queryByTestId('row-fix')).toBeNull();
        expect(screen.getByTestId('row').style.boxShadow).toBe('inset 3px 0 0 var(--success)');
        fireEvent.click(screen.getByTestId('row-rerun'));
        expect(onRerun).toHaveBeenCalledWith('GDPR-Art33-breach');
        rerender(
            <div role="table">
                <CheckRow check={{ ...base, status: 'pass' }} regulation="GDPR" columns={COLUMNS} testId="row" onRerun={onRerun} rerunning />
            </div>,
        );
        const btn = screen.getByTestId('row-rerun');
        expect(btn).toBeDisabled();
        expect(btn.querySelector('svg').getAttribute('class')).toContain('animate-spin');
    });

    it('a warn row keeps the severity word; an n/a row reads in tertiary text with the neutral stripe', () => {
        renderRow({ ...base, status: 'warn', severity: 'medium' });
        expect(screen.getByTestId('row-severity')).toHaveAttribute('data-severity', 'medium');
        expect(screen.getByTestId('row').style.boxShadow).toBe('inset 3px 0 0 var(--warning)');
    });

    it('n/a rows: neutral stripe and tertiary colour', () => {
        renderRow({ ...base, status: 'not_applicable' });
        const row = screen.getByTestId('row');
        expect(row.style.boxShadow).toBe('inset 3px 0 0 var(--bg-tertiary)');
        expect(row.style.color).toBe('var(--text-tertiary)');
        expect(screen.queryByTestId('row-severity')).toBeNull();
    });

    it('the fix button is derived from the remediation link and does not toggle the row', () => {
        const onOpenLink = vi.fn(); const onToggle = vi.fn();
        renderRow(base, { onOpenLink, onToggle });
        const fix = screen.getByTestId('row-fix');
        expect(fix).toHaveTextContent('Go to Incidents & breaches');
        fireEvent.click(fix);
        expect(onOpenLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'section', sectionId: 'incidents' }), base);
        expect(onToggle).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('row'));
        expect(onToggle).toHaveBeenCalledWith('GDPR-Art33-breach');
    });

    it('settings links say Configure, admin escapes say Open fix, and a link nobody can follow renders no button', () => {
        renderRow({ ...base, remediationLink: 'admin/compliance/settings' }, { onOpenLink: vi.fn() });
        expect(screen.getByTestId('row-fix')).toHaveTextContent('Configure');
        const { unmount } = renderRow({ ...base, check_id: 'x2', remediationLink: 'admin/monitoring/activity' }, { onOpenLink: vi.fn() });
        expect(screen.getAllByTestId('row-fix')[1]).toHaveTextContent('Open fix');
        unmount();
        renderRow({ ...base, check_id: 'x3', remediationLink: 'admin/monitoring/activity' }, { onOpenLink: vi.fn(), canOpenLink: (rem) => rem.kind !== 'external' });
        expect(screen.getAllByTestId('row-fix')).toHaveLength(1);
    });

    it('auto-fix: the button carries the affected count and opens the inline confirm strip; Apply calls onAutoFix once', () => {
        const onAutoFix = vi.fn(); const onToggle = vi.fn();
        renderRow({ ...base, autoFixId: 'fix-1', evidence: { missing_disclosure: [{ id: 'a1', name: 'Sales bot' }, { id: 'a2' }] } }, { onAutoFix, onToggle, onOpenLink: vi.fn() });
        const btn = screen.getByTestId('row-autofix');
        expect(btn).toHaveTextContent('Auto-fix');
        expect(btn).toHaveTextContent('· 2');
        expect(screen.queryByTestId('row-confirm')).toBeNull();
        fireEvent.click(btn);
        expect(onToggle).not.toHaveBeenCalled();
        const confirm = screen.getByTestId('row-confirm');
        expect(confirm).toHaveTextContent('Apply the automatic fix?');
        expect(confirm).toHaveTextContent('Sales bot');
        fireEvent.click(screen.getByTestId('row-confirm-apply'));
        expect(onAutoFix).toHaveBeenCalledTimes(1);
        expect(onAutoFix).toHaveBeenCalledWith('GDPR-Art33-breach');
        expect(screen.queryByTestId('row-confirm')).toBeNull();
    });

    it('auto-fix without a known count renders no "· 0"; Cancel closes the strip', () => {
        renderRow({ ...base, autoFixId: 'fix-1' }, { onAutoFix: vi.fn() });
        const btn = screen.getByTestId('row-autofix');
        expect(btn.textContent).not.toMatch(/·\s*0/);
        fireEvent.click(btn);
        fireEvent.click(screen.getByTestId('row-confirm-cancel'));
        expect(screen.queryByTestId('row-confirm')).toBeNull();
    });

    it('a passing row on a foreign page shows the tagged article and the home article in the also-line', () => {
        render(
            <div role="table">
                <CheckRow check={{ ...base, status: 'pass' }} regulation="ISO27001" columns={COLUMNS} testId="row" />
            </div>,
        );
        expect(screen.getByTestId('row-article')).toHaveTextContent('A.5.24');
        expect(screen.getByTestId('row-also-ref')).toHaveTextContent('GDPR Art. 33');
    });
});

describe('CheckRow — focus', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('the focused row scrolls itself into view once and wears the kind ring; expanded rows report aria-expanded', () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        renderRow(base, { focus: true, expanded: true });
        expect(screen.getByTestId('row')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('row').className).toContain('ring-[var(--kind-compliance)]');
        vi.advanceTimersByTime(100);
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
        vi.advanceTimersByTime(1000);
        expect(scroll).toHaveBeenCalledTimes(1);
    });
});

describe('CheckRow — project subjects and decisions', () => {
    it('names the project a per-source row is about, opens it, and shows an active decision', async () => {
        const { default: userEvent } = await import('@testing-library/user-event');
        const onOpenLink = vi.fn();
        const check = {
            ...base, check_id: 'GDPR-Art30-project-personal-data', scope_id: 'project:p1', status: 'warn',
            evidence: { project_id: 'p1', link: '/app/projects/p1' }, project_names: { p1: 'Launch plan' },
            finding_state: { state: 'acknowledged', active: true },
        };
        renderRow(check, { onOpenLink, canOpenLink: () => true });
        expect(screen.getByTestId('row-subject')).toHaveTextContent('Launch plan');
        expect(screen.getByTestId('row-state')).toHaveTextContent('Acknowledged');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Open the affected item' }));
        expect(onOpenLink).toHaveBeenCalledWith({ kind: 'external', path: 'projects/p1' }, check);
    });

    it('a lapsed decision shows no chip; a global row names no subject', () => {
        renderRow({ ...base, finding_state: { state: 'acknowledged', active: false } }, { onOpenLink: vi.fn() });
        expect(screen.queryByTestId('row-state')).toBeNull();
        expect(screen.queryByTestId('row-subject')).toBeNull();
    });
});
