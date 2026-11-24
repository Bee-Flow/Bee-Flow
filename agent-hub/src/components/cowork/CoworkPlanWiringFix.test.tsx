// Cowork's own fix of the wiring of a plan that is not approved, on the Plan tab (./CoworkPlanWiringFix.tsx inside
// ./CoworkPlanPanel.tsx), with the owner's Fireflies item: "Notification" reads from "AI step" but does not wait for
// it. The card asks for the fix by itself once per plan, says what was fixed, and offers "Fix it for me" where that
// did not work out. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkPlanPanel from './CoworkPlanPanel';
import type { PlanDraft, PlanState, PlanStep, PlanTried } from '@/api/coworkPlan.types';

const FINDING = "'Notification' reads from 'AI step', but does not wait for it: it would run before it or at the same time and read nothing. Let it wait for 'AI step'.";
const FIXED_LINE = "Fixed: 'Notification' now waits for 'AI step'.";
const BUDGET = 'Not tried: This cowork has used its AI budget for this month.';

const step = (id: string, kind: PlanStep['kind'], title: string, over: Partial<PlanStep> = {}): PlanStep => ({
    id, type: 'integration_action', kind, title, effect: 'reads', app: 'fireflies', tool: null, readsOutsideText: false, depth: 0, ...over,
});

function fireflies(fingerprint: string, findings: PlanDraft['findings']): PlanDraft {
    return {
        view: {
            trigger: 'schedule',
            steps: [
                step('ff_list', 'fixed', 'Fireflies: list transcripts', { tool: 'fireflies_list_transcripts' }),
                step('ff_sum', 'fixed', 'Fireflies: get summary', { tool: 'fireflies_get_summary' }),
                step('ai_1', 'ai', 'AI step', { type: 'ai_step', app: null }),
                step('tell', 'deliver', 'Notification', { type: 'notification', effect: 'sends', app: null }),
            ],
            makeUp: { fixed: 2, ai: 1, ask: 0, deliver: 1 },
        },
        permissions: { v: 1, grants: [{ app: 'fireflies', effect: 'reads', tools: ['fireflies_list_transcripts', 'fireflies_get_summary'] }], sends: 'owner', ai: true, outsideText: false },
        findings,
        fingerprint,
    };
}

const tried = (over: Partial<PlanTried>): PlanTried => ({ status: 'passed', current: true, required: false, blocksApproval: false, summary: null, problems: [], rounds: 1, ...over });

/** The owner's item as the card first gets it: miswired, untried because of it, and fixable. */
const miswired = (over: Partial<PlanState> = {}): PlanState => ({
    automationId: 'auto-ff', draft: fireflies('a'.repeat(64), [{ code: 'wiring.ref_not_upstream', stepId: 'tell', message: FINDING }]),
    approved: null, widens: [], upToDate: false, stepChanges: [],
    tried: tried({ status: 'untried', problems: [FINDING], rounds: 0 }), wiringFixable: true, ...over,
});

/** After the fix: Notification waits, tried once, nothing approved. */
const fixedState = (over: Partial<PlanTried> = {}): PlanState => ({
    automationId: 'auto-ff', draft: fireflies('b'.repeat(64), []), approved: null, widens: [], upToDate: false, stepChanges: [],
    tried: tried({ summary: { reads: [{ title: 'Fireflies: list transcripts', items: 2 }], ai: 1, held: 1 }, wiringFixed: [{ kind: 'waits', step: 'Notification', other: 'AI step' }], ...over }),
    wiringFixable: false,
});

const fixedAnswer = (state: PlanState, triedStatus: PlanTried['status']) => ({ outcome: 'fixed', changes: [{ kind: 'waits', stepId: 'tell', otherId: 'ai_1' }], tried: triedStatus, notTried: null, state });

function serve(plan: PlanState, fix: () => Response) {
    let current = plan;
    const calls = stubRecordingFetch(({ url, method }) => {
        if (method === 'POST' && url.endsWith('/plan/fix-wiring')) {
            const res = fix();
            if (res.ok) void res.clone().json().then((body: { state: PlanState }) => { current = body.state; });
            return res;
        }
        return jsonResponse(current);
    });
    return { fixes: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/plan/fix-wiring')) };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPlanWiringFix', () => {
    it('fixes the owner\'s plan by itself, once: "Fixed: …", how its try-out went, and Approve', async () => {
        const { fixes } = serve(miswired(), () => jsonResponse(fixedAnswer(fixedState(), 'passed')));
        renderWithClient(<CoworkPlanPanel coworkId="ff-1" />);
        expect(await screen.findByTestId('cowork-plan-wiring-fixed')).toHaveTextContent(FIXED_LINE);
        expect(screen.getByTestId('cowork-plan-tried')).toHaveTextContent("Tried once: 'Fireflies: list transcripts' read 2 items, the AI wrote its answer.");
        expect(screen.getByTestId('cowork-plan-approve')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-plan-fix-wiring')).toBeNull();
        expect(fixes()).toHaveLength(1);
    });

    it('asks once per plan: a refusal is not asked again, and "Fix it for me" asks with a plain sentence for an answer', async () => {
        let answer = () => jsonResponse({ error: 'Cowork cannot fix this plan by itself. Change it in Studio, or make the plan again.', code: 'cowork_wiring_no_fix' }, 422);
        const { fixes } = serve(miswired(), () => answer());
        const view = renderWithClient(<CoworkPlanPanel coworkId="ff-2" />);
        const button = await screen.findByTestId('cowork-plan-fix-wiring');
        expect(button).toHaveTextContent('Fix it for me');
        // The tab again, with the same plan: no second automatic attempt.
        view.rerender(<div />);
        view.rerender(<CoworkPlanPanel coworkId="ff-2" />);
        await screen.findByTestId('cowork-plan-fix-wiring');
        expect(fixes()).toHaveLength(1);

        await userEvent.setup().click(screen.getByTestId('cowork-plan-fix-wiring'));
        expect(await screen.findByTestId('cowork-plan-wiring-outcome')).toHaveTextContent('Cowork cannot fix this plan by itself. Change it in Studio, or make the plan again.');
        answer = () => jsonResponse(fixedAnswer(fixedState(), 'passed'));
        await userEvent.setup().click(screen.getByTestId('cowork-plan-fix-wiring'));
        await waitFor(() => expect(screen.getByTestId('cowork-plan-wiring-outcome')).toHaveTextContent('Fixed, and its try-out passed.'));
        expect(screen.getByTestId('cowork-plan-wiring-fixed')).toHaveTextContent(FIXED_LINE);
        expect(fixes()).toHaveLength(3);
    });

    it('a plan whose wiring was fixed but the budget kept from a try-out offers "Fix it for me", and says why it was not tried', async () => {
        const untried = fixedState({ status: 'untried', summary: null, problems: [BUDGET], rounds: 0 });
        const { fixes } = serve(untried, () => jsonResponse(fixedAnswer(fixedState(), 'running')));
        renderWithClient(<CoworkPlanPanel coworkId="ff-3" />);
        expect(await screen.findByTestId('cowork-plan-wiring-fixed')).toHaveTextContent(FIXED_LINE);
        expect(screen.getByTestId('cowork-plan-tried')).toHaveTextContent('Not tried yet.');
        expect(screen.getByTestId('cowork-plan-tried')).toHaveTextContent(BUDGET);
        expect(fixes()).toHaveLength(0);
        await userEvent.setup().click(screen.getByTestId('cowork-plan-fix-wiring'));
        expect(await screen.findByTestId('cowork-plan-wiring-outcome')).toHaveTextContent('Fixed. It is being tried now, without changing or sending anything.');
        expect(fixes()).toHaveLength(1);
    });
});
