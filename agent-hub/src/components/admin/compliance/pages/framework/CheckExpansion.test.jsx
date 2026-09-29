import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CheckExpansion, { remediationSteps } from './CheckExpansion';

const check = {
    check_id: 'GDPR-Art33-breach', regulation: 'GDPR', article: '33', status: 'fail', severity: 'high', weight: 3,
    // Existing dictionary keys stand in for the check's own (the real hook resolves them; an unknown key gives the '' fallback).
    descriptionKey: 'compliance.trail_evidence_hint', remediationKey: 'compliance.no_checks_yet',
    remediationLink: 'admin/compliance/incidents',
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

describe('CheckExpansion — Why · How · History', () => {
    it('loads the trail lazily on mount, once, and renders timeline dots in the status raw colour with the hash line', async () => {
        const loadTrail = vi.fn().mockResolvedValue(trail);
        renderExp({ loadTrail, exportsEnabled: true, dl: (u) => `${u}?dl=1` });
        expect(loadTrail).toHaveBeenCalledTimes(1);
        expect(loadTrail).toHaveBeenCalledWith('GDPR-Art33-breach');
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

    it('Why it matters carries the weight line; How to fix numbers the steps and offers the primary in PRIMARY_ACTION_STYLE', async () => {
        const onOpenLink = vi.fn();
        renderExp({ onOpenLink, loadTrail: vi.fn().mockResolvedValue(trail) });
        expect(screen.getByTestId('exp-weight')).toHaveTextContent('weight 3');
        const primary = screen.getByTestId('exp-primary');
        expect(primary.style.background).toBe('var(--accent-primary)');
        expect(primary.style.color).toBe('var(--accent-primary-fg)');
        expect(primary).toHaveTextContent('Go to Incidents & breaches');
        fireEvent.click(primary);
        expect(onOpenLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'section', sectionId: 'incidents' }), check);
        expect(screen.getByTestId('exp-fix').querySelectorAll('ol li')).toHaveLength(1);
        await waitFor(() => expect(screen.getByTestId('exp-timeline')).toBeInTheDocument());
    });

    it('remediation_steps[] from the registry win over the single translated step; the grid stacks under 1180 via the ctable fold', () => {
        const t = (k, en) => en || k;
        expect(remediationSteps({ remediation_steps: ['Turn it on', { key: 'x.y', text: 'Check it' }], remediationKey: 'z' }, t)).toEqual(['Turn it on', 'Check it']);
        expect(remediationSteps({ remediationKey: 'compliance.x' }, () => 'One step')).toEqual(['One step']);
        expect(remediationSteps({}, t)).toEqual([]);
        renderExp({ check: { ...check, remediation_steps: ['a', 'b', 'c'] } });
        expect(screen.getByTestId('exp-fix').querySelectorAll('ol li')).toHaveLength(3);
        const grid = screen.getByTestId('exp').firstElementChild;
        expect(grid.className).toContain('grid-cols-[1fr_1fr_1.1fr]');
        expect(grid.className).toContain('@max-[1180px]/ctable:grid-cols-1');
        expect(screen.getByTestId('exp')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('exp').style.boxShadow).toBe('inset 3px 0 0 var(--error)');
    });

    it('a passing row: no fix button, "Nothing to fix"; auto-fix on an open row without a link is the primary', () => {
        const onAutoFix = vi.fn();
        const { unmount } = renderExp({ check: { ...check, status: 'pass', remediationKey: null }, onOpenLink: vi.fn() });
        expect(screen.queryByTestId('exp-primary')).toBeNull();
        expect(screen.getByTestId('exp-fix')).toHaveTextContent('Nothing to fix');
        unmount();
        renderExp({ check: { ...check, remediationLink: null, autoFixId: 'f' }, onAutoFix });
        const btn = screen.getByTestId('exp-autofix');
        expect(btn.style.background).toBe('var(--accent-primary)');
        fireEvent.click(btn);
        expect(onAutoFix).toHaveBeenCalledWith('GDPR-Art33-breach');
    });
});
