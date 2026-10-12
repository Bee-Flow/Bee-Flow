import { render as rtlRender, act, waitFor, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * After "Build this plan" the work mode is that plan until it is done: a
 * follow-up ("continue", "fix X") and the answer to a question the build asked
 * both carry approvedPlanId, so the server runs them as a build and not as a
 * new plan turn. A plain answer in plan mode, and anything after the plan is
 * built, go out as the user's own work mode.
 */

interface BuildTabProps {
    onSend: (text: string, attachments: unknown[], options?: Record<string, unknown>) => Promise<void>;
    state: { reviewPlan: { id: string; status: string } | null; reviewQuestionsPlanId: string | null };
}

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d: unknown) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));
let buildTab: BuildTabProps | null = null;
vi.mock('./BuilderHeader', () => ({ default: () => null }));
vi.mock('./BuildTab', () => ({ default: (p: BuildTabProps) => { buildTab = p; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));

import BuilderShell from './BuilderShell.jsx';
import { queryWrapper } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';
import scopedStorage, { setCurrentUser } from '../../../utils/scopedStorage';

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: queryWrapper() });
const json = (body: unknown, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sseResponse(events: string[]) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); } });
    return { ok: true, status: 200, body: stream };
}

let bodies: Array<Record<string, unknown>>;
let nextStream: string[];

const QUESTIONS = [{ id: 'q1', prompt: 'Which channel?', options: ['Email', 'Talk'] }];
const planEvent = (status: string) => sse('review_plan', { plan: { id: 'p1', version: 2, title: 'T', steps: ['a'], status } });

/** Runs one turn that leaves the given plan state behind, then sends the follow-up and returns its body. */
async function followUp(setup: string[], text: string, options: Record<string, unknown> = {}) {
    nextStream = [sse('builder_session', { builderSessionId: 'bs1', automationId: 'a9' }), ...setup, sse('done', { automationId: 'a9', finalized: false })];
    render(<BuilderShell automationId={null} onBack={() => {}} user={{ id: 'u1' }} />);
    await waitFor(() => expect(buildTab).toBeTruthy());
    await act(async () => { await buildTab!.onSend('start', []); });
    await waitFor(() => expect(bodies.length).toBe(1));
    await waitFor(() => expect(buildTab!.state.reviewPlan).toBeTruthy());
    await waitFor(() => expect(buildTab!.state.reviewPlan).toBeTruthy());
    nextStream = [sse('builder_session', { builderSessionId: 'bs1', automationId: 'a9' }), sse('done', { automationId: 'a9', finalized: false })];
    await act(async () => { await buildTab!.onSend(text, [], options); });
    await waitFor(() => expect(bodies.length).toBe(2));
    return bodies[1];
}

describe('BuilderShell — follow-ups during an approved plan', () => {
    beforeEach(() => {
        buildTab = null; bodies = []; nextStream = [];
        setCurrentUser('u1');
        scopedStorage.setItem('automationWorkMode:new', 'plan');
        vi.mocked(authFetch).mockReset();
        vi.mocked(authFetch).mockImplementation(((url: string, opts: { method?: string; body?: string } = {}) => {
            const method = opts.method || 'GET';
            if (url.startsWith('/api/automation/builder/stream') && method === 'POST') {
                bodies.push(JSON.parse(opts.body as string));
                return Promise.resolve(sseResponse(nextStream));
            }
            if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
            if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
            if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
            if (url === '/api/automation/a9' && method === 'GET') return Promise.resolve(json({ automation: { id: 'a9', title: 'T', definition: { trigger: { kind: 'manual' }, steps: [], edges: [] } } }));
            return Promise.resolve(json({}));
        }) as never);
    });
    afterEach(cleanup);

    it('a typed follow-up while the plan is building continues it (approvedPlanId, plan mode so the server builds)', async () => {
        const body = await followUp([planEvent('building')], 'continue');
        expect(body).toMatchObject({ message: 'continue', approvedPlanId: 'p1', workMode: 'plan' });
    });

    it('the answer to a question the build asked (plan paused, planId on the questions) continues the same build', async () => {
        const body = await followUp([planEvent('paused'), sse('review_questions', { questions: QUESTIONS, planId: 'p1' })], 'Q: Which channel?\nA: Email', { answers: [{ prompt: 'Which channel?', answer: 'Email' }] });
        expect(body).toMatchObject({ approvedPlanId: 'p1', workMode: 'plan' });
    });

    it('a plain answer in plan mode (plan waiting for review, no planId) starts a plan turn', async () => {
        const body = await followUp([planEvent('review'), sse('review_questions', { questions: QUESTIONS })], 'Q: Which channel?\nA: Email', { answers: [{ prompt: 'Which channel?', answer: 'Email' }] });
        expect(body.approvedPlanId).toBeNull();
    });

    it('once the plan is built the next message is the user\'s own work mode again', async () => {
        const body = await followUp([planEvent('built')], 'add a note');
        expect(body.approvedPlanId).toBeNull();
        expect(body.workMode).toBe('plan');     // the user\'s choice, with no approved plan
    });
});
