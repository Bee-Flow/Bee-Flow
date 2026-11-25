// Setting up a new task's steps right after it is started (./useTaskSetup.ts): it follows the making as phases, and it
// never ends silently in "the AI does it each time". A task that waits for its steps keeps waiting when the set-up
// fails or the page is left; only one whose organisation has no fixed steps is the AI's from the start. The network is
// the seam (a recording fetch).
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import useTaskSetup from './useTaskSetup';
import type { CoworkSetup } from '@/api/cowork.types';

const WAITS: CoworkSetup = { steps: 'wanted', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false };
const stream = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const MADE = 'event: progress\ndata: {"phase":"thinking","round":0}\n\nevent: progress\ndata: {"phase":"trying","round":1}\n\nevent: done\ndata: {"summary":"ok","state":{"automationId":"auto-1"}}\n\n';

let calls: RecordedCall[];
const made = () => calls.filter((c) => c.url.endsWith('/api/cowork/new/plan/make'));
afterEach(() => { vi.unstubAllGlobals(); });

function setUp(answer: (call: RecordedCall) => Response) {
    calls = stubRecordingFetch(answer);
    const onDone = vi.fn();
    const hook = renderHookWithClient(() => useTaskSetup(onDone));
    return { onDone, hook };
}

describe('useTaskSetup', () => {
    it('a task that waits for its steps gets them set up and tested, and says where to approve them', async () => {
        const { onDone, hook } = setUp(({ url }) => (url.endsWith('/plan/make') ? stream(MADE) : jsonResponse({})));
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: WAITS }); });
        expect(made()).toHaveLength(1);
        expect(onDone).toHaveBeenCalledWith('Your task is ready for review.', expect.objectContaining({ id: 'new' }));
        expect(hook.result.current.setup).toBeNull();
    });

    it('a set-up that fails never becomes "the AI does it": the task waits, and the message says where to choose', async () => {
        const { onDone, hook } = setUp(({ url }) => (url.endsWith('/plan/make') ? stream('event: error\ndata: {"error":"No plan could be made for this brief.","code":"cowork_planner_empty"}\n\n') : jsonResponse({})));
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: WAITS }); });
        expect(onDone).toHaveBeenCalledWith('Setup stopped. Open the task to see what needs your attention.', expect.objectContaining({ id: 'new' }));
        expect(String(onDone.mock.calls[0]?.[0])).not.toMatch(/AI does|plan/i);
    });

    it('asks for attention when a plan was saved but its test stopped approval', async () => {
        const outcome = { state: { automationId: 'auto-1', tried: { status: 'failed', blocksApproval: true } } };
        const { onDone, hook } = setUp(() => stream('event: done\ndata: ' + JSON.stringify(outcome) + '\n\n'));
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: WAITS }); });
        expect(onDone).toHaveBeenCalledWith('Setup stopped. Open the task to see what needs your attention.', expect.objectContaining({ id: 'new' }));
    });

    it('a refusal before the making even starts is the same: it waits, nothing is decided for its owner', async () => {
        const { onDone, hook } = setUp(({ url }) => (url.endsWith('/plan/make') ? jsonResponse({ error: 'No AI model is configured for this workspace, so a plan cannot be made yet.' }, 409) : jsonResponse({})));
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: WAITS }); });
        expect(onDone).toHaveBeenCalledWith('Setup stopped. Open the task to see what needs your attention.', expect.objectContaining({ id: 'new' }));
    });

    it('a task whose organisation has no fixed steps is the AI\'s from the start: nothing is set up, and it says so', async () => {
        const { onDone, hook } = setUp(() => jsonResponse({}));
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: { ...WAITS, steps: null } }); });
        expect(made()).toHaveLength(0);
        expect(onDone).toHaveBeenCalledWith('Started. The AI works this task out on every run.', expect.objectContaining({ id: 'new' }));
    });

    it('given only its id and name, it reads the task first to know whether it waits for its steps', async () => {
        const { hook } = setUp(({ url }) => {
            if (url.endsWith('/plan/make')) return stream(MADE);
            return url.endsWith('/api/cowork/new') ? jsonResponse({ id: 'new', title: 'Meeting overview', runCount: 0, setup: WAITS }) : jsonResponse({});
        });
        await act(async () => { await hook.result.current.begin({ id: 'new', title: 'Meeting overview' }); });
        expect(calls.findIndex((c) => c.url.endsWith('/api/cowork/new'))).toBeLessThan(calls.findIndex((c) => c.url.endsWith('/plan/make')));
        expect(made()).toHaveLength(1);
    });

    it('leaving the page stops the making: the request is aborted (the server notes it), and nothing is said or decided', async () => {
        let signal: AbortSignal | null | undefined;
        calls = [];
        vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => {
            calls.push({ method: init?.method ?? 'GET', url: String(url), body: undefined });
            if (!String(url).endsWith('/plan/make')) return Promise.resolve(jsonResponse({}));
            signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError'))); });
        }));
        const onDone = vi.fn();
        const hook = renderHookWithClient(() => useTaskSetup(onDone));
        let run: Promise<void> = Promise.resolve();
        act(() => { run = hook.result.current.begin({ id: 'new', title: 'Meeting overview', setup: WAITS }); });
        await waitFor(() => expect(hook.result.current.setup).toEqual({ id: 'new', title: 'Meeting overview', phase: 'thinking' }));
        await waitFor(() => expect(signal).toBeTruthy());
        hook.unmount();
        await run;
        expect(signal?.aborted).toBe(true);
        expect(onDone).not.toHaveBeenCalled();
    });
});
