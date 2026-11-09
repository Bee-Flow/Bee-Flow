import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useFlowletAgentStream from './useFlowletAgentStream';
import { authFetch } from '../utils/helpers';
import { asMock } from '@/test/mocks';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

// Build a fake SSE Response whose body.getReader() yields the encoded
// stream once, then signals done.
const sseResponse = (sseString: string) => {
    const chunk = new TextEncoder().encode(sseString);
    let sent = false;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () =>
                    sent
                        ? Promise.resolve({ done: true, value: undefined })
                        : ((sent = true), Promise.resolve({ done: false, value: chunk })),
                cancel: () => Promise.resolve(),
            }),
        },
    };
};

const SSE = [
    'event: layer_agent_start',
    'data: {"layerKey":"enrich"}',
    '',
    'event: tool_call',
    'data: {"layerKey":"enrich","name":"builder_add_action","arguments":{},"result":{"added":{"id":"s1"}}}',
    '',
    'event: draft',
    'data: {"definition":{"trigger":{"kind":"manual"},"steps":[],"edges":[],"layers":{"enrich":{"title":"Enrich"}}}}',
    '',
    'event: layer_agent_done',
    'data: {"layerKey":"enrich","outputFields":["score"],"summary":"Looks up a contact."}',
    '',
    'event: done',
    'data: {"layerKey":"enrich"}',
    '',
].join('\n');

describe('useFlowletAgentStream', () => {
    beforeEach(() => { asMock(authFetch).mockReset(); });

    it('streams the SSE events and resolves with the draft + layerKey', async () => {
        asMock(authFetch).mockResolvedValue(sseResponse(SSE));

        const { result } = renderHook(() => useFlowletAgentStream());

        let resolved;
        await act(async () => {
            resolved = await result.current.send({
                automationId: 'a1',
                instruction: 'do x',
                mode: 'create',
            });
        });

        // The POST hit the layer-agent endpoint.
        expect(authFetch).toHaveBeenCalledWith(
            '/api/automation/builder/layer-agent',
            expect.objectContaining({ method: 'POST' }),
        );

        // Resolved value carries the draft definition + layerKey, with no error.
        expect(resolved!.error).toBeNull();
        expect(resolved!.layerKey).toBe('enrich');
        expect(resolved!.draft).toEqual({
            trigger: { kind: 'manual' },
            steps: [],
            edges: [],
            layers: { enrich: { title: 'Enrich' } },
        });

        // The streamed tool_call is captured in state.
        expect(result.current.state.toolCalls).toHaveLength(1);
        expect(result.current.state.toolCalls[0]).toMatchObject({
            layerKey: 'enrich',
            name: 'builder_add_action',
        });
        // Stream finished → no longer running.
        expect(result.current.state.running).toBe(false);
    });
    it('a send that replaces a running one keeps its own running state', async () => {
        // The first request hangs until its signal aborts, as a real fetch does.
        asMock(authFetch).mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        // The second one is still streaming: its body never yields.
        asMock(authFetch).mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => Promise.resolve() }) },
        });

        const { result } = renderHook(() => useFlowletAgentStream());

        let first: Promise<unknown> = Promise.resolve();
        act(() => { first = result.current.send({ automationId: 'a1', instruction: 'create it', mode: 'create' }); });
        act(() => { void result.current.send({ automationId: 'a1', instruction: 'refine it', mode: 'refine', layerKey: 'enrich' }); });
        // The replaced run winds down (AbortError) while the new one streams.
        await act(async () => { await first; });

        expect(result.current.state.mode).toBe('refine');
        expect(result.current.state.running).toBe(true);
    });
});
