import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAgentSave from './useAgentSave';
import { setDemoTransport } from '@/utils/helpers';
import type { AuthFetchOptions } from '@/utils/helpers.types';
import type { AgentSaveDeps, EditorSnapshot } from '@/api/agentSaveTypes';

/**
 * The closing tab's last save (useUnloadBeacon): the server saves an agent on PUT /agents/:id
 * only, so the flush is that PUT as a keepalive fetch, not a beacon (which can only POST). The
 * network is authFetch's transport seam (no module mock).
 */

type Call = { url: string; init: AuthFetchOptions };
let calls: Call[];
let answer: () => Response;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ref = <T,>(current: T) => ({ current });

function deps(over: Partial<AgentSaveDeps> = {}): AgentSaveDeps {
    const state: EditorSnapshot = {
        name: 'Invoice desk', description: 'Answers invoice questions', systemPrompt: 'Be brief.',
        model: 'm', categoryId: null, embedEnabled: false, avatar: '', config: { tools: [] },
    };
    const noop = vi.fn();
    return {
        agent: { id: 'a1' }, setAgent: noop, ro: false, roRef: ref(false), mountedRef: ref(true),
        stateRef: ref(state), agentIdRef: ref('a1'), dirtyRef: ref(true), dirty: true, setDirty: noop,
        baseVersion: 3, setBaseVersion: noop, setForcedReadOnly: noop, setInstructions: noop,
        setLimitWarning: noop, setChat: noop, setSavingState: noop, setSaveErrorMsg: noop, setSavedAt: noop,
        handleVersionRestore: vi.fn(async () => {}),
        ...over,
    };
}

const unload = () => { window.dispatchEvent(new Event('beforeunload')); };
const puts = () => calls.filter((c) => c.init?.method === 'PUT');

beforeEach(() => {
    calls = [];
    answer = () => json(200, { id: 'a1', rev: 4 });
    setDemoTransport(async (url: string, init: AuthFetchOptions) => {
        calls.push({ url, init });
        return answer();
    });
});
afterEach(() => { setDemoTransport(null); });

describe('useAgentSave — the save of a closing tab', () => {
    it('sends PUT /agents/:id as a keepalive fetch with the editor text and no baseVersion', async () => {
        renderHook(() => useAgentSave(deps()));
        await act(async () => { unload(); });

        expect(puts()).toHaveLength(1);
        const [put] = puts();
        expect(put.url).toMatch(/\/agents\/a1$/);
        expect(put.init.keepalive).toBe(true);
        expect(JSON.parse(String(put.init.body))).toEqual({
            name: 'Invoice desk', description: 'Answers invoice questions', systemPrompt: 'Be brief.', config: { tools: [] },
        });
    });

    it('sends nothing when nothing is unsaved, or the editor is read-only', async () => {
        renderHook(() => useAgentSave(deps({ dirtyRef: ref(false) })));
        renderHook(() => useAgentSave(deps({ roRef: ref(true) })));
        await act(async () => { unload(); });
        expect(puts()).toHaveLength(0);
    });

    it('a refusal is dropped without an error escaping the unload handler', async () => {
        answer = () => json(500, { error: 'down' });
        renderHook(() => useAgentSave(deps()));
        await act(async () => { unload(); });
        expect(puts()).toHaveLength(1);
    });

    it('sends nothing while a 409 waits in the conflict dialog', async () => {
        answer = () => json(409, { currentVersion: 5, agent: { id: 'a1', rev: 5 } });
        const { result } = renderHook(() => useAgentSave(deps()));
        await act(async () => { result.current.queueSave(true); await result.current.flush(); });
        expect(result.current.conflict).toEqual({ currentVersion: 5, agent: { id: 'a1', rev: 5 } });

        calls = [];
        await act(async () => { unload(); });
        expect(puts()).toHaveLength(0);
    });
});
