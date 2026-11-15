import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAgentApi from './useAgentApi';
import useAgentState from './useAgentState';

/**
 * The legacy Agent Designer (admin dashboard > Agents, and Organisation
 * settings) saves through this hook. The server stores the `config` it is
 * sent whole, so the save must carry every key the designer does not edit
 * (skills, per-app action grants, memory, the chat bubble) and the stored
 * on/off columns are Postgres booleans, not 1/0.
 */
const STORED_CONFIG = {
    attachedSkillIds: ['skill-1'],
    tools: { gmail: { actions: ['read'] } },
    memoryEnabled: true,
    useGeneralMemory: false,
    bubbleColor: '#123456',
    wizard: { step: 3 },
    allowCopy: false,
    enableGuardrails: true,
    enabledIntegrations: ['gmail'],
    knowledge_base_ids: ['kb-1'],
};

function agentRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'a1', name: 'Alpha', description: 'd', system_prompt: 'p', tools: [], tool_params: {},
        model: 'm1', is_published: true, embed_enabled: true, workspace_enabled: false,
        shared_groups: [], starter_prompts: [], avatar: 'A', category_id: null,
        config: STORED_CONFIG,
        ...overrides,
    };
}

let row: Record<string, unknown>;
// GET /agents/:id answers with the RUNTIME view (the published copy, once an
// agent is published) unless the caller asks for `?draft=1`, the editor's copy.
let draftRow: Record<string, unknown> | null;
const calls: { method: string; path: string; body: unknown }[] = [];

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    row = agentRow();
    draftRow = null;
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname.replace(/^.*\/api/, '');
        const method = (init?.method || 'GET').toUpperCase();
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET' && path === '/agents/a1' && url.searchParams.get('draft') === '1') return json(draftRow ?? row);
        if (method === 'GET' && path === '/agents/all') return json([row]);
        if (method === 'GET' && path === '/agents/a1') return json(row);
        if (method === 'GET' && path === '/agents/a1/history') return json([]);
        if (method === 'PUT' && path === '/agents/a1') return json(row);
        if (method === 'POST' && path === '/agents') return json({ ...row, id: 'a2' });
        if (method === 'GET' && path.startsWith('/agents/categories')) return json([]);
        return json({});
    }));
});

afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
    return renderHook(() => {
        const state = useAgentState();
        const api = useAgentApi(state, {});
        return { state, api };
    });
}

async function openAgent(result: ReturnType<typeof setup>['result']) {
    await waitFor(() => expect(result.current.state.agents).toHaveLength(1));
    await act(async () => { await result.current.api.selectAgent(result.current.state.agents[0]); });
}

function lastPut() {
    const put = calls.filter(c => c.method === 'PUT' && c.path === '/agents/a1').at(-1);
    expect(put).toBeDefined();
    return put!.body as { config: Record<string, unknown>; embedEnabled: boolean };
}

describe('useAgentApi', () => {
    it('reads boolean is_published / embed_enabled / workspace_enabled rows as they are stored', async () => {
        const { result } = setup();
        await openAgent(result);
        expect(result.current.state.isPublished).toBe(true);
        expect(result.current.state.embedEnabled).toBe(true);
        expect(result.current.state.workspaceEnabled).toBe(false);
    });

    it('still reads the integer spelling of an older row', async () => {
        row = agentRow({ is_published: 1, embed_enabled: 0, workspace_enabled: 1 });
        const { result } = setup();
        await openAgent(result);
        expect(result.current.state.isPublished).toBe(true);
        expect(result.current.state.embedEnabled).toBe(false);
        expect(result.current.state.workspaceEnabled).toBe(true);
    });

    it('a save keeps the config keys the designer does not edit, and the embed switch it loaded', async () => {
        const { result } = setup();
        await openAgent(result);
        act(() => { result.current.state.setEnableGuardrails(false); });
        await act(async () => { await result.current.api.saveAgent(); });
        const body = lastPut();
        expect(body.embedEnabled).toBe(true);
        expect(body.config).toMatchObject({
            attachedSkillIds: ['skill-1'],
            tools: { gmail: { actions: ['read'] } },
            memoryEnabled: true,
            useGeneralMemory: false,
            bubbleColor: '#123456',
            wizard: { step: 3 },
            // The designer's own fields win.
            enableGuardrails: false,
            enabledIntegrations: ['gmail'],
            knowledge_base_ids: ['kb-1'],
        });
    });

    it('merges over the config as stored at save time, not as it was when the agent was opened', async () => {
        const { result } = setup();
        await openAgent(result);
        // Another editor (Agent Studio) attaches a skill while the designer is open.
        row = agentRow({ config: { ...STORED_CONFIG, attachedSkillIds: ['skill-1', 'skill-2'] } });
        await act(async () => { await result.current.api.saveAgent(); });
        expect(lastPut().config.attachedSkillIds).toEqual(['skill-1', 'skill-2']);
    });

    it('a published agent is edited and saved from its draft, not from the published copy', async () => {
        // The published copy lags behind the draft: a skill and a prompt added since.
        draftRow = agentRow({
            system_prompt: 'draft prompt',
            config: { ...STORED_CONFIG, attachedSkillIds: ['skill-1', 'skill-draft'] },
        });
        const { result } = setup();
        await openAgent(result);
        expect(result.current.state.systemPrompt).toBe('draft prompt');
        await act(async () => { await result.current.api.saveAgent(); });
        const body = lastPut() as { config: Record<string, unknown>; systemPrompt?: string };
        expect(body.systemPrompt).toBe('draft prompt');
        expect(body.config.attachedSkillIds).toEqual(['skill-1', 'skill-draft']);
    });

    it('round-trips Allow copying', async () => {
        const { result } = setup();
        await openAgent(result);
        expect(result.current.state.allowCopy).toBe(false);
        await act(async () => { await result.current.api.saveAgent(); });
        expect(lastPut().config.allowCopy).toBe(false);
        act(() => { result.current.state.setAllowCopy(true); });
        await act(async () => { await result.current.api.saveAgent(); });
        expect(lastPut().config.allowCopy).toBe(true);
    });

    it('"all integrations" (null) clears a stored list instead of keeping it', async () => {
        const { result } = setup();
        await openAgent(result);
        act(() => { result.current.state.setEnabledIntegrations(null); });
        await act(async () => { await result.current.api.saveAgent(); });
        expect(lastPut().config).not.toHaveProperty('enabledIntegrations');
    });

    it('does not overwrite the config when the stored agent cannot be read at save time', async () => {
        const { result } = setup();
        await openAgent(result);
        const fetchMock = vi.mocked(globalThis.fetch);
        const inner = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input, init) => {
            const method = (init?.method || 'GET').toUpperCase();
            if (method === 'GET' && new URL(String(input), 'http://localhost').pathname.endsWith('/agents/a1')) return json({ error: 'down' }, 503);
            return inner(input, init);
        });
        await act(async () => { await result.current.api.saveAgent(); });
        expect(calls.some(c => c.method === 'PUT')).toBe(false);
    });

    it('a duplicate carries the source agent\'s config into the new agent', async () => {
        const { result } = setup();
        await waitFor(() => expect(result.current.state.agents).toHaveLength(1));
        await act(async () => { await result.current.api.duplicateAgent(result.current.state.agents[0]); });
        await act(async () => { await result.current.api.saveAgent(); });
        const post = calls.filter(c => c.method === 'POST' && c.path === '/agents').at(-1);
        expect((post!.body as { config: Record<string, unknown> }).config).toMatchObject({
            attachedSkillIds: ['skill-1'], memoryEnabled: true, allowCopy: false,
        });
    });

    it('a new agent starts from an empty config', async () => {
        const { result } = setup();
        await waitFor(() => expect(result.current.state.agents).toHaveLength(1));
        await openAgent(result);
        act(() => { result.current.api.createNewAgent(); });
        act(() => { result.current.state.setName('New'); });
        await act(async () => { await result.current.api.saveAgent(); });
        const post = calls.filter(c => c.method === 'POST' && c.path === '/agents').at(-1);
        expect((post!.body as { config: Record<string, unknown> }).config).not.toHaveProperty('attachedSkillIds');
    });
});
