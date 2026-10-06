import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from './routeEditors.harness';

/**
 * W7: a step right after a list Condition that still reads the Condition's
 * source list gets what the Condition drops. The editor says so above the
 * outputs and offers the fix, which the shell applies (routeFollow.follow).
 */
const FILTER = {
    id: 'mc_condition', type: 'filter', arrayRef: 'steps.m.output.messages',
    expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")',
};

afterEach(cleanup);

describe('StaleSuccessorsNotice in the Condition editor', () => {
    it('names the step and the list it still reads; the button follows exactly that step', async () => {
        const follow = vi.fn();
        renderRoute(FILTER, {
            routeFollow: { stale: [{ stepId: 's5', stepLabel: 'Read attachment', readsLabel: 'Read many ▸ Messages' }], follow },
        });
        expect(screen.getByText('“Read attachment” still reads Read many ▸ Messages, so what this Condition drops still reaches it.')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Use what this Condition keeps' }));
        expect(follow).toHaveBeenCalledWith(['s5']);
    });

    it('hands focus to a place that stays once the notice goes, and says what it did', async () => {
        renderRoute(FILTER, {
            routeFollow: { stale: [{ stepId: 's5', stepLabel: 'Read attachment', readsLabel: 'Read many ▸ Messages' }], follow: vi.fn() },
        });
        await userEvent.click(screen.getByRole('button', { name: 'Use what this Condition keeps' }));
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement?.textContent).toBe('Done: the next steps now read what this Condition keeps.');
    });

    it('names several steps in one sentence and follows them all with one click', async () => {
        const follow = vi.fn();
        renderRoute(FILTER, {
            routeFollow: {
                stale: [
                    { stepId: 's5', stepLabel: 'Read attachment', readsLabel: 'Read many ▸ Messages' },
                    { stepId: 's6', stepLabel: 'Save to Drive', readsLabel: 'Read many ▸ Messages' },
                ],
                follow,
            },
        });
        expect(screen.getByText('“Read attachment”, “Save to Drive” still read Read many ▸ Messages, so what this Condition drops still reaches them.')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Use what this Condition keeps' }));
        expect(follow).toHaveBeenCalledWith(['s5', 's6']);
    });

    it('says nothing when every next step reads what the Condition keeps', () => {
        renderRoute(FILTER, { routeFollow: { stale: [], follow: vi.fn() } });
        expect(screen.queryByRole('button', { name: 'Use what this Condition keeps' })).toBeNull();
        cleanup();
        renderRoute(FILTER, { routeFollow: null });
        expect(screen.queryByText(/still reads/)).toBeNull();
    });
});
