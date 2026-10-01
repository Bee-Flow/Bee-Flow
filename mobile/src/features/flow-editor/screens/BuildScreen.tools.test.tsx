/**
 * The build screen's tools over a mocked HTTP client and stream:
 *
 *   - a test run lights the cards up from the run feed while it goes, then
 *     maps its answer onto the cards (badges) and the run line ("Failed at
 *     …"), and its result sheet lists the steps with what a dry run would
 *     have done;
 *   - a card's "Run from here" is a step run in `from` mode;
 *   - the header's ⋯ reaches the version history and the settings;
 *   - "Ask AI" streams a turn whose draft replaces the flow — edits paused
 *     while it streams, nothing sent back — and one tap takes the turn back.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { SseFrame } from '@/core/api/sse';

import { resetTestRunStores } from '../components/run';
import type { FlowDefinition } from '../model';
import { peekDraftStore } from '../state';
import { MAIL_SORTER as DEF, MAIL_SORTER_ROW as row, releaseDrafts, renderBuild as mount, serveRoutine } from './testing';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
const mockStreamSse = jest.fn();
jest.mock('@/core/api/sse', () => ({ streamSse: (...args: unknown[]) => mockStreamSse(...args) }));

const AI_DRAFT: FlowDefinition = {
    ...DEF,
    steps: [...DEF.steps, { id: 'c', type: 'wait', label: 'Pause a bit' }],
    edges: [...DEF.edges, { from: 'b', to: 'c' }],
};

const step = (stepId: string, status: string, extra: Record<string, unknown> = {}) => ({
    runId: 'r1', stepId, stepType: stepId === 'a' ? 'ai_step' : 'notification', status,
    startedAt: '2026-09-01T10:00:00Z', finishedAt: '2026-09-01T10:00:01Z', ...extra,
});

/** A stream of frames that stays open until its caller aborts it (the run feed), or ends (a builder turn). */
function frames(list: SseFrame[], { hold }: { hold: boolean }) {
    return async function* (_path: string, opts: { signal?: AbortSignal } = {}) {
        for (const frame of list) yield frame;
        if (hold) await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()));
    };
}

beforeEach(() => {
    serveRoutine(row);
    mockStreamSse.mockImplementation(frames([], { hold: true }));
});

afterEach(async () => {
    await releaseDrafts();
    resetTestRunStores();
});

describe('test runs', () => {
    it('lights the cards from the run feed, then maps the answer onto the cards and the run line', async () => {
        let answer: (value: unknown) => void = () => undefined;
        (api.post as jest.Mock).mockImplementation((path: string) => {
            expect(path).toBe('/api/automation/a1/dry-run');
            return new Promise((resolve) => (answer = resolve));
        });
        mockStreamSse.mockImplementation((path: string, opts: { signal?: AbortSignal }) =>
            frames(path.startsWith('/api/automation/_runs/stream')
                ? [{ event: 'message', data: { type: 'run.started', runId: 'r1' } }, { event: 'message', data: { type: 'step.started', runId: 'r1', stepId: 'a' } }]
                : [], { hold: true })(path, opts));
        await mount();
        await screen.findByText('Sort the mail');

        await fireEvent.press(screen.getByLabelText('Test run'));
        expect(await screen.findByText('running')).toBeTruthy();
        expect(screen.getByTestId('run-stop')).toBeTruthy();

        await act(async () => {
            answer({
                run: { id: 'r1', automationId: 'a1', status: 'error', durationMs: 1200, summary: 'Stopped at the notification' },
                steps: [
                    step('a', 'success', { output: { items: [1, 2, 3] } }),
                    step('b', 'error', { error: 'No channel', output: { wouldNotify: { channels: ['inapp', 'email'], title: 'Mail sorted' } } }),
                ],
            });
        });
        expect(await screen.findByText('Failed at Tell me')).toBeTruthy();
        expect(screen.getByText('failed')).toBeTruthy();
        expect(screen.getByText('done')).toBeTruthy();

        await fireEvent.press(screen.getByTestId('run-details'));
        expect(await screen.findByText('Dry-run preview')).toBeTruthy();
        expect(screen.getByText('Stopped at the notification')).toBeTruthy();
        expect(screen.getByText('Would notify on inapp, email: Mail sorted')).toBeTruthy();
        expect(screen.getByText('No channel')).toBeTruthy();

        await fireEvent.press(within(screen.getByTestId('run-row-b')).getByText('Tell me'));
        expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/automations/[id]/steps/[stepId]', params: { id: 'a1', stepId: 'b' } });
    });

    it('runs from a card with "Run from here"', async () => {
        (api.post as jest.Mock).mockResolvedValue({ run: { id: 'r2', status: 'success' }, steps: [step('b', 'success')], stepRecord: null });
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent(screen.getByTestId('step-card-b'), 'longPress');
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Run from here' }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/a1/steps/b/run', { mode: 'from' }, expect.anything()));
    });

    it('enters a step run with the trigger’s saved sample', async () => {
        (api.get as jest.Mock).mockImplementation(async (path: string) => {
            if (path === '/api/automation/a1') return { automation: { ...row, definition: { ...DEF, trigger: { ...DEF.trigger, pinnedOutput: { name: 'Ann' } } } }, summary: '' };
            return null;
        });
        (api.post as jest.Mock).mockResolvedValue({ run: { id: 'r3', status: 'success' }, steps: [step('b', 'success')], stepRecord: null });
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent(screen.getByTestId('step-card-b'), 'longPress');
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Test this step' }));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/automation/a1/steps/b/run', { mode: 'only', triggerPayload: { name: 'Ann' } }, expect.anything()),
        );
    });
});

describe('the run menu', () => {
    const MULTI: FlowDefinition = {
        ...DEF,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', pinnedOutput: { from: 'primary' } },
        triggers: [{ id: 'hook', type: 'trigger', kind: 'webhook', label: 'Web hook', pinnedOutput: { from: 'hook' } }],
    };

    it('runs live only once asked, from the trigger chosen under "Start from", with its sample', async () => {
        (api.get as jest.Mock).mockImplementation(async (path: string) => {
            if (path === '/api/automation/a1') return { automation: { ...row, definition: MULTI }, summary: '' };
            if (path === '/api/automation/catalog') return { apps: [], flags: { code: true } };
            return null;
        });
        (api.post as jest.Mock).mockResolvedValue({ accepted: true, run: { id: 'r9', status: 'success' }, steps: [step('a', 'success')] });
        await mount();
        await screen.findByText('Sort the mail');

        await fireEvent.press(screen.getByTestId('run-more'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Start from Web hook' }));
        await fireEvent.press(screen.getByTestId('run-more'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Run live' }));
        expect(await screen.findByText('Run this routine for real?')).toBeTruthy();
        expect(api.post).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByLabelText('Run it'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/automation/a1/run', { triggerPayload: { from: 'hook' }, triggerStepId: 'hook' }, expect.anything()),
        );

        await fireEvent.press(screen.getByLabelText('Test run'));
        await waitFor(() =>
            expect(api.post).toHaveBeenLastCalledWith('/api/automation/a1/dry-run', { triggerPayload: { from: 'hook' }, triggerStepId: 'hook' }, expect.anything()),
        );
    });
});

describe('the header', () => {
    it('reaches the version history and the settings from ⋯', async () => {
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent.press(screen.getByLabelText('More'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Version history' }));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/a1/versions');
        await fireEvent.press(screen.getByLabelText('More'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Settings' }));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/a1/settings');
    });
});

describe('Diagnose', () => {
    it('probes an app-event trigger from ⋯ and lists what it found', async () => {
        const mail: FlowDefinition = { ...DEF, trigger: { id: 'trg', type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } };
        (api.get as jest.Mock).mockImplementation(async (path: string) => {
            if (path === '/api/automation/a1') return { automation: { ...row, definition: mail }, summary: '' };
            return null;
        });
        (api.post as jest.Mock).mockResolvedValue({
            ok: false,
            kind: 'gmail.mail.new',
            checks: [{ name: 'credentials', status: 'error', message: 'No Gmail credentials found.' }],
        });
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent.press(screen.getByLabelText('More'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Diagnose the trigger' }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/a1/diagnose-trigger', {}, { retry: false }));
        expect(await screen.findByText('No Gmail credentials found.')).toBeTruthy();
        expect(screen.getByText(/One or more checks failed/)).toBeTruthy();
    });

    it('is not offered for a trigger it cannot probe', async () => {
        await mount();
        await screen.findByText('Sort the mail');
        await fireEvent.press(screen.getByLabelText('More'));
        await screen.findByRole('menuitem', { name: 'Settings' });
        expect(screen.queryByRole('menuitem', { name: 'Diagnose the trigger' })).toBeNull();
    });
});

describe('Ask AI', () => {
    it('streams a turn whose draft replaces the flow, and takes it back in one tap', async () => {
        let finish: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (finish = resolve));
        mockStreamSse.mockImplementation((path: string, opts: { signal?: AbortSignal }) => {
            if (path !== '/api/automation/builder/stream') return frames([], { hold: true })(path, opts);
            return (async function* () {
                yield { event: 'builder_session', data: { builderSessionId: 'bs1', automationId: 'a1' } };
                yield { event: 'draft', data: { definition: AI_DRAFT, automationId: 'a1' } };
                yield { event: 'tool_call', data: { name: 'builder_add_step', result: { added: { id: 'c', type: 'wait', label: 'Pause a bit' } } } };
                yield { event: 'message', data: { content: 'Added a pause.' } };
                await gate;
                yield { event: 'done', data: {} };
            })();
        });
        await mount();
        await screen.findByText('Sort the mail');
        const store = peekDraftStore('a1');

        await fireEvent.press(screen.getByLabelText('Ask AI'));
        await fireEvent.press(await screen.findByText('Process each item with AI'));
        expect(screen.getByTestId('ai-input').props.value).toBe('Process each item with AI');
        await fireEvent.press(screen.getByTestId('ai-send'));

        await waitFor(() => expect(store?.getState().definition).toEqual(AI_DRAFT));
        expect(store?.getState().locked).toBe(true);
        expect(await screen.findByTestId('ai-live')).toBeTruthy();
        expect(api.put).not.toHaveBeenCalled();

        await act(async () => finish());
        await waitFor(() => expect(store?.getState().locked).toBe(false));
        expect(await screen.findByText('Added a pause.')).toBeTruthy();
        expect(screen.getAllByText('Pause a bit').length).toBeGreaterThan(0);

        await fireEvent.press(await screen.findByTestId('ai-undo'));
        expect(store?.getState().definition?.steps).toHaveLength(2);
    });
});
