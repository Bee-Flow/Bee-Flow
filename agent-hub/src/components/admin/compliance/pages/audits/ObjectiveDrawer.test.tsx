import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObjectiveDrawer from './ObjectiveDrawer';
import type { Objective } from './ObjectiveDrawer';

/**
 * ObjectiveDrawer: the one place an objective's steps live now that the
 * table rows carry no buttons. Pinned: the facts an auditor reads (measure,
 * target, owner by name, review date), and the footer steps that write the
 * new status: Mark achieved (primary) and Drop for an active objective,
 * Reactivate for an achieved or dropped one.
 */

vi.mock('../../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key: string, fallback?: string, params?: Record<string, unknown>) => {
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

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }];
const ACTIVE: Objective = {
    id: 5, title: 'Reduce incident MTTR', status: 'active', measure: 'Mean time to resolve', target: 'under 4 hours',
    owner_user_id: 'u1', review_due_at: '2027-03-02T12:00:00Z',
};

function renderDrawer(objective: Objective, onStatus = vi.fn(), onClose = vi.fn()) {
    render(<ObjectiveDrawer objective={objective} orgUsers={USERS} mode="inline" onClose={onClose} onStatus={onStatus} />);
    return { onStatus, onClose };
}

describe('ObjectiveDrawer', () => {
    it('shows the measure, the target, the owner by name and the review date', () => {
        renderDrawer(ACTIVE);
        expect(screen.getByTestId('objective-drawer-measure').textContent).toContain('Mean time to resolve');
        expect(screen.getByTestId('objective-drawer-target').textContent).toContain('under 4 hours');
        expect(screen.getByTestId('objective-drawer-owner').textContent).toContain('T. Smit');
        expect(screen.getByTestId('objective-drawer-owner').textContent).not.toContain('u1');
        expect(screen.getByTestId('objective-drawer-review').textContent).toMatch(/2 Mar 2027/);
    });

    it('an active objective: Mark achieved is the footer primary, Drop sits beside it', async () => {
        const user = userEvent.setup();
        const { onStatus } = renderDrawer(ACTIVE);
        const footer = screen.getByTestId('objective-footer');
        expect(within(footer).queryByTestId('objective-drawer-reactivate')).toBeNull();
        await user.click(within(footer).getByTestId('objective-drawer-achieve'));
        expect(onStatus).toHaveBeenLastCalledWith('achieved');
        await user.click(within(footer).getByTestId('objective-drawer-drop'));
        expect(onStatus).toHaveBeenLastCalledWith('dropped');
        expect(onStatus).toHaveBeenCalledTimes(2);
    });

    it.each(['achieved', 'dropped'])('a %s objective can only be reactivated', async (status) => {
        const user = userEvent.setup();
        const { onStatus } = renderDrawer({ ...ACTIVE, status });
        const footer = screen.getByTestId('objective-footer');
        expect(within(footer).queryByTestId('objective-drawer-achieve')).toBeNull();
        expect(within(footer).queryByTestId('objective-drawer-drop')).toBeNull();
        await user.click(within(footer).getByTestId('objective-drawer-reactivate'));
        expect(onStatus).toHaveBeenCalledWith('active');
    });

    it('a busy register disables the steps', () => {
        render(<ObjectiveDrawer objective={ACTIVE} orgUsers={USERS} busy mode="inline" onClose={vi.fn()} onStatus={vi.fn()} />);
        expect((screen.getByTestId('objective-drawer-achieve') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('objective-drawer-drop') as HTMLButtonElement).disabled).toBe(true);
    });

    it('missing facts read as a dash, never as blank or a raw id', () => {
        renderDrawer({ id: 6, title: 'Bare objective', status: 'active' });
        expect(screen.getByTestId('objective-drawer-measure').textContent).toContain('—');
        expect(screen.getByTestId('objective-drawer-target').textContent).toContain('—');
        expect(screen.getByTestId('objective-drawer-owner').textContent).toContain('—');
        expect(screen.getByTestId('objective-drawer-review').textContent).toContain('—');
    });
});
