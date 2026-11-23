// The Plan tab of an item: without a plan ONE way to a plan is in sight ("Make it routine" when the past runs say
// so, otherwise "Make a plan") and the others wait under "More ways"; an approved plan says how independent it is in
// one line that opens to the choice. The network is the seam (a recording fetch), no module is mocked.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextType, ReactNode } from 'react';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import EntitlementsContext from '../licensing/EntitlementsContext';
import CoworkPlanPanel from './CoworkPlanPanel';
import { planState, supplierRadarDraft } from './coworkPlan.fixture';

type Entitlements = ContextType<typeof EntitlementsContext>;
const ALLOWED = { loading: false, can: (id: string) => id === 'automations' } as unknown as Entitlements;
const withAutomations = (ui: ReactNode) => <EntitlementsContext.Provider value={ALLOWED}>{ui}</EntitlementsContext.Provider>;

const NO_PLAN = { automationId: null, draft: null, approved: null, widens: [], upToDate: true };
const routine = (worthIt: boolean) => ({ applicable: true, needed: 3, signals: { runs: 6, worthIt, readsOutsideText: false, habits: [], steady: [{ tool: 'web_search', app: 'web', inRuns: 6, callsPerRun: 2 }] } });

function serve({ plan = NO_PLAN as unknown, worthIt = false, automations = [{ id: 'a1', title: 'Order intake' }] } = {}) {
    stubRecordingFetch(({ url }) => {
        if (url.endsWith('/routine')) return jsonResponse(routine(worthIt));
        if (url.endsWith('/api/automation')) return jsonResponse({ automations });
        if (url.endsWith('/independence')) {
            return jsonResponse({
                chosen: null, level: 'asks_before_sending', asksAvailable: true, letThrough: 3, needed: 10,
                options: [
                    { level: 'asks_everything', open: true, asksBefore: ['Mail the supplier'] },
                    { level: 'asks_before_sending', open: true, asksBefore: ['Mail the supplier'] },
                    { level: 'on_its_own', open: false, asksBefore: [] },
                ],
            });
        }
        if (url.endsWith('/trust')) {
            return jsonResponse({
                needed: 5, ceilingAllows: true,
                entries: [
                    { stepId: 'a', title: 'Mail the supplier', recipient: 'o@s.example', letThrough: 6, trusted: true, canTrust: false },
                    { stepId: 'b', title: 'Save the draft', recipient: '*', letThrough: 6, trusted: true, canTrust: false },
                ],
            });
        }
        return jsonResponse(plan);
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPlanPanel — no plan yet', () => {
    it('shows "Make a plan" in sight and the other ways under "More ways"', async () => {
        serve();
        renderWithClient(withAutomations(<CoworkPlanPanel coworkId="w1" />));
        expect(await screen.findByTestId('cowork-plan-make-start')).toBeInTheDocument();
        const more = await screen.findByTestId('cowork-plan-more');
        expect(more).not.toHaveAttribute('open');
        expect(within(more).getByText('More ways')).toBeInTheDocument();
        expect(within(more).getByTestId('cowork-plan-attach')).toBeInTheDocument();
        expect(within(more).queryByTestId('cowork-plan-make')).toBeNull();
        expect(screen.queryByTestId('cowork-routine')).toBeNull();
    });

    it('offers "Make it routine" first when the history allows it, and "Make a plan" under "More ways"', async () => {
        serve({ worthIt: true });
        renderWithClient(withAutomations(<CoworkPlanPanel coworkId="w1" />));
        const routineCard = await screen.findByTestId('cowork-routine');
        expect(routineCard).toHaveTextContent('Make it routine');
        const more = screen.getByTestId('cowork-plan-more');
        expect(within(more).getByTestId('cowork-plan-make')).toBeInTheDocument();
        expect(within(more).getByTestId('cowork-plan-attach')).toBeInTheDocument();
    });

    it('has no "More ways" when there is no other way', async () => {
        serve({ automations: [] });
        renderWithClient(withAutomations(<CoworkPlanPanel coworkId="w1" />));
        expect(await screen.findByTestId('cowork-plan-make-start')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-plan-more')).toBeNull();
    });

    it('shows the fallback sentence to someone who cannot give it a plan', async () => {
        serve();
        const denied = { loading: false, can: () => false } as unknown as Entitlements;
        renderWithClient(
            <EntitlementsContext.Provider value={denied}>
                <CoworkPlanPanel coworkId="w1" fallback={<p>Runs without a plan.</p>} />
            </EntitlementsContext.Provider>,
        );
        expect(await screen.findByText('Runs without a plan.')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-plan-none')).toBeNull();
    });
});

describe('CoworkPlanPanel — an approved plan', () => {
    it('says how independent it is in one line, which opens to the choice', async () => {
        const approved = planState({ approved: { version: 2, fingerprint: 'f'.repeat(64), approvedAt: new Date().toISOString(), permissions: supplierRadarDraft().permissions }, widens: [], upToDate: true });
        serve({ plan: approved });
        renderWithClient(withAutomations(<CoworkPlanPanel coworkId="w1" />));
        const line = await screen.findByTestId('cowork-autonomy-line');
        await vi.waitFor(() => expect(line).toHaveTextContent('Asks before sending · 2 steps go on their own'));
        const disclosure = screen.getByTestId('cowork-autonomy');
        expect(disclosure).not.toHaveAttribute('open');
        await userEvent.setup().click(screen.getByText('Change'));
        expect(disclosure).toHaveAttribute('open');
        expect(within(disclosure).getByRole('radio', { name: /Ask before anything leaves Bee Flow/ })).toBeChecked();
    });
});
