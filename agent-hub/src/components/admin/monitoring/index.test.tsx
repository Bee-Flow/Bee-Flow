// AI Monitor. Pinned: the figures on screen belong to the range that is
// selected; a slow answer for the range that was left is dropped.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import MonitoringPanel from './index';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const summary = (calls: number) => ({ total_calls: calls, total_tokens: 0, total_estimated_cost: 0, total_billed_cost: 0, avg_duration_ms: 0 });

afterEach(() => { setDemoTransport(null); });

describe('MonitoringPanel range switch', () => {
    it('keeps the selected range when the answer for the previous one arrives late', async () => {
        const user = userEvent.setup();
        let releaseRanged: () => void = () => {};
        const rangedGate = new Promise<void>((resolve) => { releaseRanged = resolve; });
        const pending: Promise<unknown>[] = [];
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            // The default 7-day range filters by date; "All Time" sends no filter.
            const ranged = address.includes('startDate');
            if (ranged) { pending.push(rangedGate); await rangedGate; }
            if (address.includes('/api/usage/summary')) return json(summary(ranged ? 777 : 42));
            if (address.includes('/summary')) return json({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            if (address.includes('/model-costs')) return json({});
            return json([]);
        });

        render(<MonitoringPanel activeSection="overview" />);
        await user.click(await screen.findByRole('radio', { name: 'All Time' }));
        expect(await screen.findByText('42')).toBeTruthy();

        // The 7-day read that was still on its way answers now.
        releaseRanged();
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
        expect(screen.queryByText('777')).toBeNull();
    });
});

describe('MonitoringPanel scope', () => {
    /** Answers every read; the usage summary carries `scope`. Returns the URLs asked for. */
    function serve(scope: unknown) {
        const asked: string[] = [];
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            asked.push(address);
            if (address.includes('/api/usage/summary')) return json({ ...summary(5), scope });
            if (address.includes('/api/terminations') && address.includes('/summary')) return json({ total: 0, by_type: {} });
            if (address.includes('/api/terminations')) return json({ rows: [] });
            if (address.includes('/summary')) return json({ total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 });
            if (address.includes('/model-costs')) return json({});
            return json([]);
        });
        return asked;
    }
    const ORG_A = { organizationId: 'org-a', organizationName: 'Org A', allOrganizations: false };
    const ALL = { organizationId: null, organizationName: null, allOrganizations: true };
    const feedbackReads = (asked: string[]) => asked.filter((u) => u.includes('/api/feedback'));

    const ORG_ADMIN = { isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-a', isHomeOrgAdmin: true };
    const PLATFORM_ADMIN = { isAdmin: true, role: 'admin' };

    it('names the organisation the figures cover and reads its own feedback', async () => {
        const asked = serve(ORG_A);
        render(<MonitoringPanel activeSection="feedback" user={ORG_ADMIN} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Feedback' })).toBeTruthy();
        expect(await screen.findByText('Usage of Org A')).toBeTruthy();
        await waitFor(() => expect(feedbackReads(asked).length).toBe(2));
        expect(feedbackReads(asked).every((u) => u.includes('/api/feedback/org'))).toBe(true);
    });

    it('says when the figures cover every organisation and reads the instance-wide feedback', async () => {
        const asked = serve(ALL);
        render(<MonitoringPanel activeSection="feedback" user={PLATFORM_ADMIN} />);
        expect(screen.getByRole('heading', { level: 2, name: 'Feedback' })).toBeTruthy();
        expect(await screen.findByText('Usage of all organisations')).toBeTruthy();
        await waitFor(() => expect(feedbackReads(asked).length).toBe(2));
        expect(feedbackReads(asked).some((u) => u.includes('/api/feedback/org'))).toBe(false);
    });

    // The dashboard's organisation picker: one organisation chosen narrows every read to it.
    it('sends the organisation chosen in the dashboard as orgId with the usage, feedback and terminations reads', async () => {
        const choice: AdminOrgChoice = {
            isPlatformAdmin: true, orgId: 'org-a', orgName: 'Org A', organizations: [{ id: 'org-a', name: 'Org A' }],
            organizationsLoaded: true, pending: false, homeOrganization: null, setOrgId: () => {},
        };
        const asked = serve(ORG_A);
        const { unmount } = render(<AdminOrgProvider value={choice}><MonitoringPanel activeSection="feedback" user={PLATFORM_ADMIN} /></AdminOrgProvider>);
        await screen.findByText('Usage of Org A');
        await waitFor(() => expect(feedbackReads(asked).length).toBe(2));
        const usage = asked.filter((u) => u.includes('/api/usage/') && !u.includes('/model-costs'));
        expect(usage.length).toBeGreaterThan(5);
        expect(usage.every((u) => u.includes('orgId=org-a'))).toBe(true);
        expect(feedbackReads(asked).every((u) => u.includes('/api/feedback/org') && u.includes('orgId=org-a'))).toBe(true);
        unmount();

        const again = serve(ORG_A);
        render(<AdminOrgProvider value={choice}><MonitoringPanel activeSection="terminations" user={PLATFORM_ADMIN} /></AdminOrgProvider>);
        const terminationReads = () => again.filter((u) => u.includes('/api/terminations'));
        await waitFor(() => expect(terminationReads().length).toBe(4));
        expect(terminationReads().every((u) => u.includes('/api/terminations/org') && u.includes('orgId=org-a'))).toBe(true);
    });

    it('sends no orgId when no organisation is chosen', async () => {
        const asked = serve(ALL);
        render(<MonitoringPanel activeSection="overview" user={PLATFORM_ADMIN} />);
        await screen.findByText('Usage of all organisations');
        expect(asked.some((u) => u.includes('orgId='))).toBe(false);
    });

    // The /org routes need an organisation admin; the generic route needs only
    // admin_monitoring, the tab's own permission (a DPO or auditor holds it).
    it('reads terminations from the generic route, also when the figures cover one organisation', async () => {
        const asked = serve(ORG_A);
        render(<MonitoringPanel activeSection="terminations" />);
        await screen.findByText('Usage of Org A');
        const terminationReads = () => asked.filter((u) => u.includes('/api/terminations'));
        await waitFor(() => expect(terminationReads().length).toBe(4));
        expect(terminationReads().some((u) => u.includes('/api/terminations/org'))).toBe(false);
    });
});
