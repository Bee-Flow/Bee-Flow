import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CheckRow, { CheckCard, compactRemediation } from './CheckRow';
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
    it('a failing row: error stripe, a neutral severity word, the cross-framework line, the article, the verification glyph and the last-run time', () => {
        renderRow(base, { onOpenLink: vi.fn(), onToggle: vi.fn() });
        const row = screen.getByTestId('row');
        expect(row.style.boxShadow).toBe('inset 3px 0 0 var(--error)');
        expect(row).toHaveAttribute('aria-expanded', 'false');
        const sev = screen.getByTestId('row-severity');
        expect(sev).toHaveAttribute('data-severity', 'high');
        expect(sev).toHaveAttribute('data-tone', 'neutral');
        expect(sev.style.color).toBe('');
        expect(screen.getByTestId('row-also')).toHaveTextContent('also counts for');
        expect(screen.getByTestId('row-also-ref')).toHaveTextContent('ISO A.5.24');
        expect(screen.getByTestId('row-also-ref')).not.toHaveTextContent('GDPR');
        expect(screen.getByTestId('row-article')).toHaveTextContent('Art. 33');
        const chip = screen.getByTestId('row-verification');
        expect(chip).toHaveAttribute('data-verification', 'automated');
        expect(chip).toHaveAttribute('data-compact', 'true');
        expect(chip).toHaveTextContent('Verified automatically');
        expect(screen.getByTestId('row-last-run')).toHaveTextContent('09:05');
        expect(screen.getByText('No breach detector configured').className).toContain('truncate');
    });

    it('the title line wraps, so the severity word drops under a long title instead of squeezing it', () => {
        renderRow(base);
        expect(screen.getByTestId('row-title').parentElement.className).toContain('flex-wrap');
        // The full title is the tooltip (the test translator falls back to the id).
        expect(screen.getByTestId('row-title')).toHaveAttribute('title', 'GDPR-Art33-breach');
    });

    it('a passing row shows no severity word, no fix and no rerun button: the row stays quiet', () => {
        renderRow({ ...base, status: 'pass' }, { onOpenLink: vi.fn() });
        expect(screen.queryByTestId('row-severity')).toBeNull();
        expect(screen.queryByTestId('row-fix')).toBeNull();
        expect(screen.queryByRole('button', { name: /Re-run/ })).toBeNull();
        expect(screen.getByTestId('row').style.boxShadow).toBe('inset 3px 0 0 var(--success)');
    });

    it('a warn row keeps the severity word', () => {
        renderRow({ ...base, status: 'warn', severity: 'medium' });
        expect(screen.getByTestId('row-severity')).toHaveAttribute('data-severity', 'medium');
        expect(screen.getByTestId('row').style.boxShadow).toBe('inset 3px 0 0 var(--warning)');
    });

    it('n/a rows: neutral stripe and tertiary text', () => {
        renderRow({ ...base, status: 'not_applicable' });
        const row = screen.getByTestId('row');
        expect(row.style.boxShadow).toBe('inset 3px 0 0 var(--bg-tertiary)');
        expect(row.className).toContain('text-[var(--text-tertiary)]');
        expect(screen.queryByTestId('row-severity')).toBeNull();
    });

    it('one compact "Fix" whose accessible name and title say where it goes; it does not toggle the row', async () => {
        const user = userEvent.setup();
        const onOpenLink = vi.fn(); const onToggle = vi.fn();
        renderRow({ ...base, remediationLink: 'admin/compliance/ropa' }, { onOpenLink, onToggle });
        const fix = screen.getByRole('button', { name: /^Fix/ });
        expect(fix).toBe(screen.getByTestId('row-fix'));
        expect(fix).toHaveAccessibleName('Fix — Go to Processing register (ROPA)');
        expect(fix).toHaveAttribute('title', 'Go to Processing register (ROPA)');
        await user.click(fix);
        expect(onOpenLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'section', sectionId: 'ropa' }), expect.objectContaining({ check_id: 'GDPR-Art33-breach' }));
        expect(onToggle).not.toHaveBeenCalled();
        await user.click(screen.getByTestId('row'));
        expect(onToggle).toHaveBeenCalledWith('GDPR-Art33-breach:');
    });

    it('no rerun and no auto-fix in the row, even for a check that has an automatic fix', () => {
        renderRow({ ...base, autoFixId: 'fix-1', evidence: { missing_disclosure: [{ id: 'a1', name: 'Sales bot' }] } }, { onOpenLink: vi.fn() });
        expect(screen.getAllByRole('button')).toEqual([screen.getByTestId('row-fix')]);
        expect(screen.queryByText(/Auto-fix/)).toBeNull();
        expect(screen.queryByTestId('row-autofix')).toBeNull();
        expect(screen.queryByTestId('row-rerun')).toBeNull();
    });

    it('the request queue says Handle; settings and admin escapes keep the short word with their own destination; a link nobody can follow renders no button', () => {
        const t = (k, en, vars) => (vars ? en.replace('{section}', vars.section) : en);
        expect(compactRemediation({ kind: 'section', sectionId: 'dsr' }, t)).toMatchObject({ short: 'Handle', named: true, destination: expect.stringMatching(/^Go to /) });
        expect(compactRemediation({ kind: 'settings', sectionId: 'settings' }, t)).toMatchObject({ short: 'Fix', destination: 'Go to Settings' });
        expect(compactRemediation({ kind: 'external', path: 'admin/monitoring' }, t)).toMatchObject({ short: 'Fix', named: false, destination: 'Open fix' });
        expect(compactRemediation(null, t)).toBeNull();
        renderRow({ ...base, remediationLink: 'admin/monitoring/activity' }, { onOpenLink: vi.fn(), canOpenLink: (rem) => rem.kind !== 'external' });
        expect(screen.queryByTestId('row-fix')).toBeNull();
    });

    it('the actions column is narrow and clips instead of running over the Verification column', () => {
        const actions = COLUMNS.find((c) => c.id === 'actions');
        expect(actions.width).toBe('112px');
        renderRow(base, { onOpenLink: vi.fn() });
        const cell = screen.getByTestId('row-fix').parentElement;
        expect(cell.className).toContain('min-w-0');
        expect(cell.className).toContain('overflow-hidden');
        expect(COLUMNS.find((c) => c.id === 'last_run').foldBelow).toBe(900);
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

describe('CheckRow — subjects and decisions', () => {
    it('names the project a per-source row is about, opens it, and shows an active decision', async () => {
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

    it('an agent row names its agent (four DPIA rows can be told apart)', () => {
        renderRow({
            ...base, check_id: 'GDPR-Art35-dpia-high-risk', scope_id: 'agent_claims', status: 'pass',
            evidence: { agent_id: 'agent_claims', agent_name: 'Schadebeoordeling', subject_label: 'Schadebeoordeling' },
        });
        expect(screen.getByTestId('row-subject')).toHaveTextContent('Schadebeoordeling');
        expect(screen.queryByTestId('row-open-subject')).toBeNull();
    });

    it('a lapsed decision shows no chip; a global row names no subject', () => {
        renderRow({ ...base, finding_state: { state: 'acknowledged', active: false }, evidence: { agent_name: 'Ignored' } }, { onOpenLink: vi.fn() });
        expect(screen.queryByTestId('row-state')).toBeNull();
        expect(screen.queryByTestId('row-subject')).toBeNull();
    });
});

describe('CheckCard — the narrow and phone variant', () => {
    it('leads its meta line with the subject, shows the finding on one line and the whole title', async () => {
        const onToggle = vi.fn();
        render(
            <CheckCard
                check={{ ...base, check_id: 'GDPR-Art35-dpia-high-risk', scope_id: 'agent_claims', evidence: { agent_name: 'Schadebeoordeling' } }}
                regulation="GDPR" onToggle={onToggle} testId="card" now={new Date(2026, 8, 14, 15).getTime()}
            />,
        );
        const meta = screen.getByTestId('card-subject').parentElement;
        expect(meta.firstElementChild).toBe(screen.getByTestId('card-subject'));
        expect(screen.getByTestId('card-subject')).toHaveTextContent('Schadebeoordeling');
        expect(screen.getByTestId('card-details')).toHaveTextContent('No breach detector configured');
        expect(screen.getByTestId('card-details').className).toContain('truncate');
        expect(screen.getByTestId('card-title').className).not.toContain('truncate');
        expect(within(meta).getByTestId('card-verification')).toHaveAttribute('data-compact', 'true');
        await userEvent.setup().click(screen.getByTestId('card'));
        expect(onToggle).toHaveBeenCalledWith('GDPR-Art35-dpia-high-risk:agent_claims');
    });
});
