import { render, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ProjectOverviewTab from './ProjectOverviewTab';

/**
 * The Overview band is the "one solution" view: every kind counted together,
 * what is running right now, and what just happened.
 *
 * Two behaviours here are load-bearing rather than cosmetic:
 *
 *   1. `null` IS NOT ZERO. The resources endpoint returns null for a section
 *      whose store could not be reached, and [] when nothing is filed. Showing
 *      "0 automations" when the truth is "we could not ask" tells someone their
 *      work has disappeared.
 *   2. APPROVALS COUNT WHAT IS WAITING, not how many ever existed — a project
 *      with 200 decided approvals and none pending is not a project with 200
 *      things to do.
 */

const RESOURCES = {
    notebooks: [{ id: 'n1' }],
    apps: [{ id: 'a1' }, { id: 'a2' }],
    automations: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
    webpages: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }],
    datatables: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` })),
    agents: Array.from({ length: 7 }, (_, i) => ({ id: `g${i}` })),
    knowledgeBases: Array.from({ length: 8 }, (_, i) => ({ id: `k${i}` })),
    approvals: [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, status: 'pending' })),
        { id: 'd1', status: 'approved' },
        { id: 'd2', status: 'rejected' },
    ],
};

function renderTab(props = {}) {
    return render(
        <ProjectOverviewTab
            resources={RESOURCES}
            loading={false}
            activity={[]}
            activeRuns={{}}
            formatActivity={(item) => item.action}
            formatRelative={() => 'just now'}
            {...props}
        />,
    );
}

describe('the shape of the project', () => {
    it('counts every kind side by side', () => {
        // One tile per registered section, in the section order — the list is
        // imported from the Content tab rather than restated, so a kind added
        // there appears here without anybody remembering to add it.
        const { container } = renderTab();
        const tiles = container.querySelectorAll('button');
        expect(tiles).toHaveLength(8);
        const numbers = [...tiles].map(t => t.textContent.match(/\d+|—/)?.[0]);
        expect(numbers).toEqual(['1', '2', '3', '4', '6', '7', '8', '5']);
    });

    it('counts only the approvals still waiting', () => {
        const { container } = renderTab();
        // 7 rows, 5 pending — a decided approval is history, not a task.
        const approvalTile = [...container.querySelectorAll('button')].at(-1);
        expect(approvalTile.textContent).toContain('5');
        expect(approvalTile.textContent).not.toContain('7');
    });

    it('shows a dash, never a zero, for a section it could not load', () => {
        const { container } = renderTab({
            resources: { ...RESOURCES, automations: null },
        });
        const tiles = [...container.querySelectorAll('button')];
        const automationTile = tiles[2];
        expect(automationTile.textContent).toContain('—');
        expect(automationTile.textContent).not.toContain('0');
    });

    it('treats an empty section as a real zero', () => {
        const { container } = renderTab({ resources: { ...RESOURCES, automations: [] } });
        expect([...container.querySelectorAll('button')][2].textContent).toContain('0');
    });

    it('sends you to the content tab when a count is clicked', () => {
        const onOpenTab = vi.fn();
        const { container } = renderTab({ onOpenTab });
        container.querySelector('button').click();
        expect(onOpenTab).toHaveBeenCalledWith('resources');
    });
});

describe('running now', () => {
    it('stays out of the way when nothing is running', () => {
        const { queryByText } = renderTab();
        expect(queryByText('Running now')).toBeNull();
    });

    it('names each automation that is mid-run', () => {
        const { getByText } = renderTab({
            activeRuns: {
                r1: { runId: 'r1', automationTitle: 'Nightly invoices' },
                r2: { runId: 'r2', automationTitle: 'Sync CRM' },
            },
        });
        expect(getByText('Running now')).toBeTruthy();
        expect(getByText('Nightly invoices')).toBeTruthy();
        expect(getByText('Sync CRM')).toBeTruthy();
    });

    it('falls back to a placeholder rather than an empty row', () => {
        const { getByText } = renderTab({ activeRuns: { r1: { runId: 'r1', automationTitle: '' } } });
        expect(getByText('Untitled automation')).toBeTruthy();
    });
});

describe('recent activity', () => {
    it('stays compact', () => {
        const activity = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, action: `event ${i}`, createdAt: 'now' }));
        const { container } = renderTab({ activity });
        expect(container.querySelectorAll('li')).toHaveLength(8);
    });

    it('says so when there is nothing yet', () => {
        const { getByText } = renderTab({ activity: [] });
        expect(getByText('Nothing here yet.')).toBeTruthy();
    });

    it('renders each entry through the page formatters', () => {
        const { container } = renderTab({
            activity: [{ id: 'e1', action: 'alice added a webpage', createdAt: 'now' }],
        });
        const row = container.querySelector('li');
        expect(within(row).getByText('alice added a webpage')).toBeTruthy();
        expect(within(row).getByText('just now')).toBeTruthy();
    });
});

describe('first load', () => {
    it('spins rather than claiming the project is empty', () => {
        const { container } = renderTab({ resources: null, loading: true });
        expect(container.querySelectorAll('button')).toHaveLength(0);
        expect(container.querySelector('.animate-spin')).toBeTruthy();
    });
});
