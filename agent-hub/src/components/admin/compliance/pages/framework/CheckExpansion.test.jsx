import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import CheckExpansion, { remediationSteps } from './CheckExpansion';
import { ofSubject } from './checkSort';

const check = {
    check_id: 'GDPR-Art33-breach', regulation: 'GDPR', article: '33', status: 'fail', severity: 'high', weight: 3,
    // Existing dictionary keys stand in for the check's own (the real hook resolves them; an unknown key gives the '' fallback).
    descriptionKey: 'compliance.trail_evidence_hint', remediationKey: 'compliance.no_checks_yet',
    remediationLink: 'admin/compliance/incidents',
    details: 'No breach detector is configured, so a breach would go unnoticed for longer than the 72 hours Art. 33 allows.',
};

const trail = {
    history: [
        { id: 1, status: 'fail', run_at: '2026-09-14T07:00:00Z', run_type: 'scheduled' },
        { id: 2, status: 'pass', run_at: '2026-09-13T07:00:00Z', run_type: 'manual' },
    ],
    evidence: [{ id: 9, hash: 'abcdef0123456789deadbeef', seq: 412, captured_at: '2026-09-14T07:00:00Z' }],
};

function renderExp(props = {}) {
    return render(
        <div role="table">
            <CheckExpansion check={check} regulation="GDPR" testId="exp" {...props} />
        </div>,
    );
}

describe('CheckExpansion — the History & evidence column', () => {
    it('loads the trail lazily on mount, once, and renders timeline dots in the status raw colour with the hash line', async () => {
        const loadTrail = vi.fn().mockResolvedValue(trail);
        renderExp({ loadTrail, exportsEnabled: true, dl: (u) => `${u}?dl=1` });
        expect(loadTrail).toHaveBeenCalledTimes(1);
        expect(loadTrail).toHaveBeenCalledWith('GDPR-Art33-breach', null);
        expect(screen.getByTestId('exp-history')).toHaveAttribute('aria-busy', 'true');
        await waitFor(() => expect(screen.getByTestId('exp-timeline')).toBeInTheDocument());
        const items = screen.getByTestId('exp-timeline').querySelectorAll('li');
        expect(items).toHaveLength(2);
        expect(items[0].querySelector('span').style.background).toBe('var(--error)');
        expect(items[1].querySelector('span').style.background).toBe('var(--success)');
        expect(items[0].className).toContain('grid-cols-[8px_96px_1fr]');
        expect(screen.getByTestId('exp-hash')).toHaveTextContent('sha256 abcdef012345');
        expect(screen.getByTestId('exp-hash')).toHaveTextContent('chain intact');
        const link = screen.getByTestId('exp-evidence-link');
        expect(link).toHaveAttribute('href', expect.stringMatching(/\/api\/compliance\/evidence\/GDPR-Art33-breach\?dl=1$/));
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveTextContent('Evidence (JSON)');
    });

    it('a per-subject row asks for its own subject and shows only that subject\'s runs and evidence', async () => {
        const mine = { ...check, check_id: 'GDPR-Art35-dpia-high-risk', scope_id: 'agent_claims' };
        const loadTrail = vi.fn().mockResolvedValue({
            history: [
                { id: 1, status: 'fail', run_at: '2026-09-14T07:00:00Z', scope_id: 'agent_claims' },
                { id: 2, status: 'pass', run_at: '2026-09-14T07:00:00Z', scope_id: 'agent_intake' },
                { id: 3, status: 'pass', run_at: '2026-09-13T07:00:00Z', scope_id: 'agent_helpdesk' },
            ],
            evidence: [
                { id: 8, hash: '111111111111aaaa', subject_id: 'agent_intake' },
                { id: 9, hash: '222222222222bbbb', subject_id: 'agent_claims' },
            ],
        });
        renderExp({ check: mine, loadTrail });
        expect(loadTrail).toHaveBeenCalledWith('GDPR-Art35-dpia-high-risk', 'agent_claims');
        await waitFor(() => expect(screen.getByTestId('exp-timeline')).toBeInTheDocument());
        const items = screen.getByTestId('exp-timeline').querySelectorAll('li');
        expect([...items].map((li) => li.dataset.status)).toEqual(['fail']);
        expect(screen.getByTestId('exp-hash')).toHaveTextContent('sha256 222222222222');
    });

    it('ofSubject keeps every row for a global check and rows that do not say whose they are', () => {
        const rows = [{ scope_id: 'a' }, { scope_id: 'b' }, { scope_id: null }, { status: 'pass' }];
        expect(ofSubject(rows, null)).toHaveLength(4);
        expect(ofSubject(rows, 'a')).toEqual([{ scope_id: 'a' }, { status: 'pass' }]);
        expect(ofSubject(null, 'a')).toEqual([]);
    });

    it('a failed trail read is its own line, never an empty history', async () => {
        renderExp({ loadTrail: vi.fn().mockRejectedValue(new Error('500')) });
        await waitFor(() => expect(screen.getByTestId('exp-trail-failed')).toBeInTheDocument());
        expect(screen.queryByTestId('exp-timeline')).toBeNull();
        expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    });

    it('the evidence download is hidden when exports are off; an empty history says so', async () => {
        renderExp({ loadTrail: vi.fn().mockResolvedValue({ history: [], evidence: trail.evidence }), exportsEnabled: false });
        await waitFor(() => expect(screen.getByTestId('exp-hash')).toBeInTheDocument());
        expect(screen.queryByTestId('exp-evidence-link')).toBeNull();
        expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument();
    });
});

describe('CheckExpansion — What we found · Why · How', () => {
    it('"What we found" opens the left column with the whole finding, and is left out when there is none', () => {
        const { unmount } = renderExp();
        const found = screen.getByTestId('exp-found');
        expect(found).toHaveTextContent('What we found');
        expect(found).toHaveTextContent(check.details);
        expect(found.querySelector('p').className).toContain('text-[var(--text-primary)]');
        expect(found.querySelector('p').className).not.toContain('truncate');
        expect(found.parentElement.firstElementChild).toBe(found);
        unmount();
        renderExp({ check: { ...check, details: null } });
        expect(screen.queryByTestId('exp-found')).toBeNull();
    });

    it('Why it matters carries the weight line; How to fix numbers the steps and offers the full-label primary', async () => {
        const user = userEvent.setup();
        const onOpenLink = vi.fn();
        renderExp({ onOpenLink, loadTrail: vi.fn().mockResolvedValue(trail) });
        expect(screen.getByTestId('exp-weight')).toHaveTextContent('weight 3');
        const primary = screen.getByTestId('exp-primary');
        expect(primary.style.background).toBe('var(--accent-primary)');
        expect(primary.style.color).toBe('var(--accent-primary-fg)');
        expect(primary).toHaveTextContent('Go to Incidents & breaches');
        await user.click(primary);
        expect(onOpenLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'section', sectionId: 'incidents' }), check);
        expect(screen.getByTestId('exp-fix').querySelectorAll('ol li')).toHaveLength(1);
        await waitFor(() => expect(screen.getByTestId('exp-timeline')).toBeInTheDocument());
    });

    it('remediation_steps[] win over the single step; two columns that stack under a 760px card', () => {
        const t = (k, en) => en || k;
        expect(remediationSteps({ remediation_steps: ['Turn it on', { key: 'x.y', text: 'Check it' }], remediationKey: 'z' }, t)).toEqual(['Turn it on', 'Check it']);
        expect(remediationSteps({ remediationKey: 'compliance.x' }, () => 'One step')).toEqual(['One step']);
        expect(remediationSteps({}, t)).toEqual([]);
        renderExp({ check: { ...check, remediation_steps: ['a', 'b', 'c'] } });
        expect(screen.getByTestId('exp-fix').querySelectorAll('ol li')).toHaveLength(3);
        const grid = screen.getByTestId('exp').firstElementChild;
        expect(grid.className).toContain('grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]');
        expect(grid.className).toContain('@max-[760px]/ctable:grid-cols-1');
        expect(grid.className).not.toContain('1180');
        expect(grid.children).toHaveLength(2);
        expect(grid.children[1]).toBe(screen.getByTestId('exp-history'));
        expect(screen.getByTestId('exp')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('exp').style.boxShadow).toBe('inset 3px 0 0 var(--error)');
    });

    it('a passing row: no fix button, "Nothing to fix"', () => {
        renderExp({ check: { ...check, status: 'pass', remediationKey: null }, onOpenLink: vi.fn() });
        expect(screen.queryByTestId('exp-primary')).toBeNull();
        expect(screen.getByTestId('exp-fix')).toHaveTextContent('Nothing to fix');
    });
});

describe('CheckExpansion — Auto-fix asks first, Re-run is always there', () => {
    const fixable = { ...check, remediationLink: null, autoFixId: 'f', evidence: { missing_disclosure: [{ id: 'a1', name: 'Sales bot' }, { id: 'a2' }] } };

    it('Auto-fix opens the confirm with the affected agents; onAutoFix is not called before "Apply fix"', async () => {
        const user = userEvent.setup();
        const onAutoFix = vi.fn();
        renderExp({ check: fixable, onAutoFix });
        const btn = screen.getByTestId('exp-autofix');
        expect(btn.className).toContain('bg-[var(--accent-primary)]'); // the primary when there is no link
        await user.click(btn);
        expect(onAutoFix).not.toHaveBeenCalled();
        const confirm = screen.getByRole('group', { name: 'Apply the automatic fix?' });
        expect(confirm).toHaveTextContent('Sales bot');
        expect(confirm).toHaveTextContent('a2');
        expect(btn).toBeDisabled();
        await user.click(screen.getByRole('button', { name: /Apply fix/ }));
        expect(onAutoFix).toHaveBeenCalledTimes(1);
        expect(onAutoFix).toHaveBeenCalledWith('GDPR-Art33-breach');
        expect(screen.queryByTestId('exp-confirm')).toBeNull();
    });

    it('Cancel closes the confirm without fixing anything', async () => {
        const user = userEvent.setup();
        const onAutoFix = vi.fn();
        renderExp({ check: fixable, onAutoFix });
        await user.click(screen.getByTestId('exp-autofix'));
        await user.click(screen.getByTestId('exp-confirm-cancel'));
        expect(screen.queryByTestId('exp-confirm')).toBeNull();
        expect(onAutoFix).not.toHaveBeenCalled();
    });

    it('Auto-fix says how many items it touches (as the row did), and nothing when the count is unknown', () => {
        const { unmount } = renderExp({ check: fixable, onAutoFix: vi.fn() });
        expect(screen.getByTestId('exp-autofix-count')).toHaveTextContent('· 2');
        unmount();
        renderExp({ check: { ...fixable, evidence: {} }, onAutoFix: vi.fn() });
        expect(screen.queryByTestId('exp-autofix-count')).toBeNull();
    });

    it('the keyboard follows the confirm: focus lands on "Apply fix", and goes back to Auto-fix on Cancel', async () => {
        const user = userEvent.setup();
        renderExp({ check: fixable, onAutoFix: vi.fn() });
        screen.getByTestId('exp-autofix').focus();
        await user.keyboard('{Enter}');
        expect(screen.getByTestId('exp-confirm-apply')).toHaveFocus();
        await user.click(screen.getByTestId('exp-confirm-cancel'));
        await waitFor(() => expect(screen.getByTestId('exp-autofix')).toHaveFocus());
    });

    it('"Re-run this check" sits in the History header for a failing row and spins while it runs', async () => {
        const user = userEvent.setup();
        const onRerun = vi.fn();
        const { rerender } = renderExp({ onRerun });
        const rerun = screen.getByRole('button', { name: 'Re-run this check' });
        expect(screen.getByTestId('exp-history').contains(rerun)).toBe(true);
        await user.click(rerun);
        expect(onRerun).toHaveBeenCalledWith('GDPR-Art33-breach');
        rerender(
            <div role="table">
                <CheckExpansion check={check} regulation="GDPR" testId="exp" onRerun={onRerun} rerunning />
            </div>,
        );
        const busy = screen.getByRole('button', { name: 'Re-run this check' });
        expect(busy).toBeDisabled();
        expect(busy.querySelector('svg').getAttribute('class')).toContain('animate-spin');
    });

    it('a passing row has Re-run too', () => {
        renderExp({ check: { ...check, status: 'pass' }, onRerun: vi.fn() });
        expect(screen.getByRole('button', { name: 'Re-run this check' })).toBeEnabled();
    });
});
