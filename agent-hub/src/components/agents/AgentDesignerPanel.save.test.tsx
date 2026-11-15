import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import AgentDesignerPanel from './AgentDesignerPanel';
import type { PanelAgent } from './AgentDesignerPanel.types';

/**
 * The Agent Hub designer panel saves with PUT /agents/:id, and the server
 * stores the `config` it is sent whole. The panel loaded its agent earlier
 * (from the hub's list, the published copy), while Agent Studio may have
 * changed the DRAFT since. A save therefore re-reads the draft and merges
 * only the keys the panel edited over it, like the legacy designer does.
 */
const LOADED_CONFIG = { attachedSkillIds: ['skill-1'], memoryEnabled: false };
const DRAFT_CONFIG = {
    attachedSkillIds: ['skill-1'],
    memoryEnabled: true,
    tools: { gmail: { actions: ['read'] } },
    bubbleColor: '#123456',
};

const agent: PanelAgent = {
    id: 'a1', name: 'Alpha', description: 'd', system_prompt: 'p', tools: [], tool_params: {},
    model: '', starter_prompts: [], workspace_enabled: false, copy_enabled: true,
    is_published: true, embed_enabled: false, organization_id: null, shared_groups: [], category_id: null,
    config: LOADED_CONFIG,
};

const calls: { method: string; path: string; query: string; body: unknown }[] = [];

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname.replace(/^.*\/api/, '');
        const method = (init?.method || 'GET').toUpperCase();
        calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET' && path === '/agents/a1' && url.searchParams.get('draft') === '1') return json({ ...agent, config: DRAFT_CONFIG });
        if (method === 'GET' && path === '/agents/a1') return json(agent);
        if (method === 'PUT' && path === '/agents/a1') return json(agent);
        if (method === 'GET' && path.startsWith('/agents/categories')) return json([]);
        return json({});
    }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('AgentDesignerPanel save', () => {
    it('merges the edited fields over the draft config as stored now, keeping keys written elsewhere', async () => {
        renderWithClient(<AgentDesignerPanel agent={agent} onClose={() => {}} />);
        await userEvent.click(await screen.findByTestId('agent-save-btn'));

        await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
        const draftRead = calls.findIndex(c => c.method === 'GET' && c.path === '/agents/a1' && c.query.includes('draft=1'));
        const put = calls.findIndex(c => c.method === 'PUT' && c.path === '/agents/a1');
        expect(draftRead).toBeGreaterThanOrEqual(0);
        expect(draftRead).toBeLessThan(put);
        const sent = (calls[put].body as { config: Record<string, unknown> }).config;
        // Written by Agent Studio after the panel loaded: kept.
        expect(sent.tools).toEqual({ gmail: { actions: ['read'] } });
        expect(sent.bubbleColor).toBe('#123456');
        // Not edited in the panel: the stored value wins over the stale loaded one.
        expect(sent.memoryEnabled).toBe(true);
        expect(sent.attachedSkillIds).toEqual(['skill-1']);
    });
});
