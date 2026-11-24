// The goal line under a cowork's brief: "Goal: <sentence> — 46 of 49 this week", or a quiet "Add a goal" that opens
// the editor: sentence → "Draft the check" → the check in plain words → "Approve the check". The network is the seam
// (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkGoal from './CoworkGoal';
import type { CoworkGoal as Goal, GoalCheck } from '@/api/coworkGoals';

const SENTENCE = 'Every supplier mail gets an answer within two working days';
const READS_ONLY: GoalCheck = {
    automationId: 'auto-check', readsOnly: true, findings: [], fingerprint: 'f'.repeat(64),
    steps: [
        { id: 'mail', title: 'Read the supplier mail of the week', type: 'integration_action', effect: 'reads', app: 'outlook', depth: 0 },
        { id: 'count', title: 'Count the answers in time', type: 'set', effect: 'reads', app: null, depth: 0 },
    ],
};
const goal = (over: Partial<Goal> = {}): Goal => ({ sentence: SENTENCE, targetPercent: 95, check: null, approved: null, upToDate: false, count: null, results: [], trend: null, ...over });

let calls: RecordedCall[];
/** The server: the goal as it stands, and what each change makes of it. */
function serve(first: Goal | null, after: { put?: Goal; check?: Goal; approve?: Goal } = {}) {
    calls = stubRecordingFetch(({ method, url }) => {
        if (method === 'PUT') return jsonResponse({ goal: after.put ?? null });
        if (method === 'POST' && url.endsWith('/goal/check')) return jsonResponse({ summary: 'Counts the answers in time.', goal: after.check ?? null });
        if (method === 'POST' && url.endsWith('/goal/approve')) return jsonResponse({ goal: after.approve ?? null });
        if (method === 'DELETE') return jsonResponse({ goal: null });
        return jsonResponse({ goal: first });
    });
}
const sent = (method: string, ending: string) => calls.filter((c) => c.method === method && c.url.endsWith(ending));

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkGoal', () => {
    it('shows the goal with its latest count and which way it goes', async () => {
        serve(goal({ check: READS_ONLY, approved: { fingerprint: READS_ONLY.fingerprint, approvedAt: null }, upToDate: true, count: { met: 46, total: 49, percent: 94, period: 'this week', measuredAt: null }, trend: 'up' }));
        renderWithClient(<CoworkGoal coworkId="w1" />);
        expect(await screen.findByTestId('cowork-goal-line')).toHaveTextContent(`Goal: ${SENTENCE} — 46 of 49 this week, going up`);
    });

    it('a cowork without a goal has a quiet link; from a sentence to a drafted check in plain words to its approval', async () => {
        const drafted = goal({ check: READS_ONLY });
        serve(null, { put: goal(), check: drafted, approve: { ...drafted, approved: { fingerprint: READS_ONLY.fingerprint, approvedAt: null }, upToDate: true } });
        renderWithClient(<CoworkGoal coworkId="w1" />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Add a goal' }));
        expect(screen.getByText('Working days are Monday to Friday. Public holidays count as working days.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('The goal, in one sentence'), SENTENCE);
        await user.clear(screen.getByLabelText('Share that should meet it (%)'));
        await user.type(screen.getByLabelText('Share that should meet it (%)'), '95');
        await user.click(screen.getByRole('button', { name: 'Draft the check' }));

        const check = await screen.findByTestId('cowork-goal-check');
        expect(check).toHaveTextContent('Read the supplier mail of the week · reads');
        expect(check).toHaveTextContent('Reads only: the check changes and sends nothing.');
        expect(screen.getByTestId('cowork-goal-approval')).toHaveTextContent('nothing is measured until you approve it');
        expect(sent('PUT', '/api/cowork/w1/goal')[0].body).toEqual({ sentence: SENTENCE, targetPercent: 95 });
        expect(sent('POST', '/api/cowork/w1/goal/check')).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: 'Approve the check' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/goal/approve')).toHaveLength(1));
        expect(sent('POST', '/api/cowork/w1/goal/approve')[0].body).toEqual({ fingerprint: READS_ONLY.fingerprint });
        expect(await screen.findByText('The check is approved. It runs after every run of this work.')).toBeInTheDocument();
    });

    it('a check that would change or send says why, and cannot be approved', async () => {
        const sending: GoalCheck = { ...READS_ONLY, readsOnly: false, steps: [{ ...READS_ONLY.steps[0], effect: 'sends', title: 'Mail the boss' }], findings: [{ code: 'goal.not_read_only', stepId: 'mail', message: 'A goal\'s check cannot change or send anything: "Mail the boss" sends something.' }] };
        serve(goal({ check: sending }));
        renderWithClient(<CoworkGoal coworkId="w1" />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        expect(screen.getByTestId('cowork-goal-check')).toHaveTextContent('Mail the boss · sends something');
        expect(screen.getByRole('alert')).toHaveTextContent('"Mail the boss" sends something.');
        expect(screen.getByRole('button', { name: 'Approve the check' })).toBeDisabled();
    });

    it('a reworded goal is saved before its check is drafted again, and taking it off removes it', async () => {
        serve(goal({ check: READS_ONLY }), { put: goal({ sentence: 'Every mail gets an answer the same day' }), check: goal({ sentence: 'Every mail gets an answer the same day', check: READS_ONLY }) });
        renderWithClient(<CoworkGoal coworkId="w1" />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const field = screen.getByLabelText('The goal, in one sentence');
        await user.clear(field);
        await user.type(field, 'Every mail gets an answer the same day');
        expect(screen.queryByTestId('cowork-goal-check')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Draft the check' }));
        await waitFor(() => expect(sent('POST', '/api/cowork/w1/goal/check')).toHaveLength(1));
        expect(sent('PUT', '/api/cowork/w1/goal')[0].body).toEqual({ sentence: 'Every mail gets an answer the same day', targetPercent: 95 });
        await user.click(screen.getByRole('button', { name: 'Take the goal off' }));
        await waitFor(() => expect(sent('DELETE', '/api/cowork/w1/goal')).toHaveLength(1));
        expect(await screen.findByRole('button', { name: 'Add a goal' })).toBeInTheDocument();
    });
});
