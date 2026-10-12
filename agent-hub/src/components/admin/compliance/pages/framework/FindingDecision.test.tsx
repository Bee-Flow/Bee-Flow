import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AffectedProjects, { affectedProjects } from './AffectedProjects';
import FindingDecision, {
    decisionErrorText, FindingStateChip, reviewDateBounds, reviewDateToIso, type DecideFinding,
} from './FindingDecision';

const OPEN = { check_id: 'GDPR-Art32-project-access', scope_id: null, status: 'warn' };

/** A local calendar day `days` from today, as the date input takes it. */
function inDays(days: number): string {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderDecision(check: Record<string, unknown>, onDecide: DecideFinding = vi.fn(async () => ({}))) {
    render(<FindingDecision check={check as never} onDecide={onDecide} testId="fd" />);
    return { onDecide, user: userEvent.setup() };
}

describe('FindingDecision', () => {
    it('acknowledges and snoozes an open finding for its slot', async () => {
        const { onDecide, user } = renderDecision({ ...OPEN, scope_id: 'project:p1' });
        expect(screen.getByRole('group', { name: 'Decide about this finding' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Acknowledge/ }));
        expect(onDecide).toHaveBeenCalledWith('GDPR-Art32-project-access', 'project:p1', { state: 'acknowledged' });
        await user.click(screen.getByRole('button', { name: /Snooze/ }));
        await user.click(screen.getByRole('menuitem', { name: '30 days' }));
        expect(onDecide).toHaveBeenLastCalledWith('GDPR-Art32-project-access', 'project:p1', { state: 'snoozed', days: 30 });
    });

    it('accepting a risk asks for a reason first, then sends it with the optional review date', async () => {
        const { onDecide, user } = renderDecision(OPEN);
        await user.click(screen.getByRole('button', { name: /Accept risk/ }));
        await user.click(screen.getByTestId('fd-accept-save'));
        expect(screen.getByRole('alert')).toHaveTextContent('Write a reason of at least 3 characters.');
        expect(onDecide).not.toHaveBeenCalled();
        await user.type(screen.getByLabelText('Why is this risk accepted?'), 'Legal hold');
        const day = inDays(90);
        await user.type(screen.getByLabelText('Review by (optional)'), day);
        await user.click(screen.getByTestId('fd-accept-save'));
        expect(onDecide).toHaveBeenCalledWith('GDPR-Art32-project-access', null, {
            state: 'accepted_risk', reason: 'Legal hold', until: new Date(`${day}T12:00:00`).toISOString(),
        });
        await waitFor(() => expect(screen.queryByTestId('fd-accept-form')).toBeNull());
    });

    it('shows the current decision, says when it lapsed, and re-opens', async () => {
        const { onDecide, user } = renderDecision({ ...OPEN, finding_state: { state: 'accepted_risk', reason: 'Legal hold', active: false } });
        expect(screen.getByTestId('fd-current')).toHaveTextContent('Risk accepted');
        expect(screen.getByTestId('fd-current')).toHaveTextContent('Reason: Legal hold');
        expect(screen.getByTestId('fd-lapsed')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Re-open/ }));
        expect(onDecide).toHaveBeenCalledWith('GDPR-Art32-project-access', null, { state: 'open' });
    });

    it('a refused decision is said inline', async () => {
        const { user } = renderDecision(OPEN, vi.fn(async () => { throw new Error('500 Internal Server Error'); }));
        await user.click(screen.getByRole('button', { name: /Acknowledge/ }));
        expect(await screen.findByTestId('fd-failed')).toHaveTextContent('The decision could not be saved.');
    });

    it('offers only review days the server accepts: tomorrow to a year from today', async () => {
        const { user } = renderDecision(OPEN);
        await user.click(screen.getByRole('button', { name: /Accept risk/ }));
        const input = screen.getByLabelText('Review by (optional)');
        expect(input).toHaveAttribute('min', inDays(1));
        expect(input).toHaveAttribute('max', inDays(365));
    });

    it.each([['today', 0], ['more than a year away', 400]])('a review day %s is not sent, and the form says which days work', async (_label, days) => {
        const { onDecide, user } = renderDecision(OPEN);
        await user.click(screen.getByRole('button', { name: /Accept risk/ }));
        await user.type(screen.getByLabelText('Why is this risk accepted?'), 'Legal hold');
        await user.type(screen.getByLabelText('Review by (optional)'), inDays(days));
        await user.click(screen.getByTestId('fd-accept-save'));
        expect(screen.getByTestId('fd-until-invalid')).toHaveTextContent('Pick a day between tomorrow and a year from today.');
        expect(screen.getByLabelText('Review by (optional)')).toHaveAttribute('aria-invalid', 'true');
        expect(onDecide).not.toHaveBeenCalled();
    });

    it('a refusal says why, from the server\'s status and code, not only "failed"', async () => {
        const refusal = (status: number, code: string) => Object.assign(new Error(`${status} x`), { status, code });
        const { user } = renderDecision(OPEN, vi.fn(async () => { throw refusal(409, 'finding_not_open'); }));
        await user.click(screen.getByRole('button', { name: /Acknowledge/ }));
        expect(await screen.findByTestId('fd-failed')).toHaveTextContent('This finding is no longer open');
    });

    it('renders nothing for a passing row without a decision, or without a way to decide', () => {
        const { container } = render(<FindingDecision check={{ ...OPEN, status: 'pass' }} onDecide={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
        const second = render(<FindingDecision check={OPEN} />);
        expect(second.container).toBeEmptyDOMElement();
    });
});

describe('review dates and refusals', () => {
    const DAY = 86_400_000;
    // The server's rule (routes/compliance/findingStates.js _until): after now,
    // and at most 365 days + 1 day away.
    const serverAccepts = (iso: string, now: number) => { const ms = Date.parse(iso); return ms > now && ms <= now + 366 * DAY; };

    it('every day between the bounds is one the server accepts, at any time of that day', () => {
        for (const hour of [0, 1, 11, 12, 13, 22, 23]) {
            const now = new Date(2026, 2, 28, hour, 59); // around a daylight-saving change in Europe
            const { min, max } = reviewDateBounds(now);
            expect(serverAccepts(reviewDateToIso(min), now.getTime())).toBe(true);
            expect(serverAccepts(reviewDateToIso(max), now.getTime())).toBe(true);
        }
    });

    it('words each refusal the decision endpoint gives', () => {
        const t = (_k: string, fallback: string) => fallback;
        const err = (status: number, code: string | null = null) => ({ status, code });
        expect(decisionErrorText(err(400, 'invalid_request'), t)).toMatch(/between tomorrow and a year/);
        expect(decisionErrorText(err(409, 'framework_disabled'), t)).toMatch(/framework that is not active/);
        expect(decisionErrorText(err(404, 'unknown_check'), t)).toMatch(/no longer exists/);
        expect(decisionErrorText(err(403), t)).toMatch(/compliance administrator/);
        expect(decisionErrorText(new Error('network'), t)).toBe('The decision could not be saved.');
    });
});

describe('FindingStateChip', () => {
    it('labels an active decision and hides a lapsed one', () => {
        const { rerender } = render(<FindingStateChip state={{ state: 'acknowledged', active: true }} testId="chip" />);
        expect(screen.getByTestId('chip')).toHaveTextContent('Acknowledged');
        rerender(<FindingStateChip state={{ state: 'acknowledged', active: false }} testId="chip" />);
        expect(screen.queryByTestId('chip')).toBeNull();
        rerender(<FindingStateChip state={{ state: 'snoozed', until: '2026-10-06T00:00:00Z', active: true }} testId="chip" />);
        expect(screen.getByTestId('chip')).toHaveTextContent(/^Snoozed until .*2026/);
    });
});

describe('AffectedProjects', () => {
    const check = {
        scope_id: null,
        evidence: { offenders: [{ project_id: 'p1', link: '/app/projects/p1/members' }, { project_id: 'abcdefghij' }] },
        project_names: { p1: 'Launch' },
    };

    it('lists the current names, an id reference when the name is unknown, and opens a project', async () => {
        const onOpen = vi.fn();
        render(<AffectedProjects check={check} onOpen={onOpen} testId="ap" />);
        expect(screen.getByTestId('ap')).toHaveTextContent('Launch');
        expect(screen.getByTestId('ap')).toHaveTextContent('project:abcdefgh');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Open the affected item: Launch' }));
        expect(onOpen).toHaveBeenCalledWith('projects/p1/members');
        expect(screen.queryByTestId('ap-open-abcdefghij')).toBeNull();
    });

    it('reads a per-source project row and a row about nothing', () => {
        expect(affectedProjects({ scope_id: 'project:p9', evidence: { link: '/app/projects/p9' }, project_names: {} }))
            .toEqual([{ id: 'p9', name: 'project:p9', path: 'projects/p9' }]);
        expect(affectedProjects({ scope_id: null, evidence: {} })).toEqual([]);
    });
});

describe('FindingDecision — the Snooze menu', () => {
    it('three decisions on an open finding: Acknowledge, Accept risk…, and one Snooze menu with 7 and 30 days', async () => {
        const { onDecide, user } = renderDecision(OPEN);
        const group = screen.getByRole('group', { name: 'Decide about this finding' });
        const buttons = [...group.querySelectorAll('button')].map((b) => b.textContent?.trim());
        expect(buttons).toEqual(['Acknowledge', 'Accept risk…', 'Snooze']);
        const snooze = screen.getByRole('button', { name: 'Snooze' });
        expect(snooze).toHaveAttribute('aria-haspopup', 'menu');
        expect(snooze).toHaveAttribute('aria-expanded', 'false');
        await user.click(snooze);
        expect(snooze).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['7 days', '30 days']);
        await user.click(screen.getByRole('menuitem', { name: '7 days' }));
        expect(onDecide).toHaveBeenCalledWith('GDPR-Art32-project-access', null, { state: 'snoozed', days: 7 });
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('the Snooze menu opens from the keyboard and Escape closes it', async () => {
        const { onDecide, user } = renderDecision(OPEN);
        screen.getByRole('button', { name: 'Snooze' }).focus();
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menu')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('menuitem', { name: '7 days' })).toHaveFocus());
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(onDecide).not.toHaveBeenCalled();
    });
});
