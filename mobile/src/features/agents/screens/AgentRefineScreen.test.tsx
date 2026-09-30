/**
 * "Edit with AI" against canned answers, in the web's order: the refine,
 * then the undo point, then ONE save of the merged snapshot — and a Done card
 * that names what actually changed, with Undo restoring the pre_refine version.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { AgentRefineScreen } from './AgentRefineScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ ...jest.requireActual('@/core/access'), useHasPermission: () => true }));

const AGENT = {
    id: 'a1',
    name: 'Helpdesk',
    description: 'IT questions',
    avatar: '🛠️',
    model: 'tier:fast',
    owner_id: 'u1',
    is_published: false,
    starter_prompts: null,
    config: { enabledIntegrations: ['gmail'], knowledge_base_ids: ['kb1'], attachedSkillIds: [] },
    organization_id: 'o1',
    shared_groups: [],
    rev: 5,
    can_edit: true,
    system_prompt: 'Be helpful.',
};

const wrap = (ui: ReactElement) => renderWithProviders(<ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>);

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/agents/a1') return Promise.resolve(AGENT);
        if (path === '/ai/config/tiers-for-user') return Promise.resolve({ fast: {}, thinking: {} });
        if (path === '/ai/user-settings') return Promise.resolve({ enabledApps: null, orgEnabledIntegrations: null });
        if (path === '/api/skills') return Promise.resolve([]);
        return Promise.resolve(null);
    });
    (api.post as jest.Mock).mockImplementation((path: string) => {
        if (path === '/agents/wizard/refine') {
            return Promise.resolve({
                plan: { systemPrompt: 'Be formal.', enabledIntegrations: ['agent-search'], knowledge_base_ids: [] },
                preserved: { model: 'tier:fast', enabledIntegrations: ['gmail'], knowledge_base_ids: ['kb1'] },
            });
        }
        if (path === '/versions/a1/pre-refine') return Promise.resolve({ id: 'v1' });
        return Promise.resolve({});
    });
    (api.put as jest.Mock).mockResolvedValue({ ...AGENT, system_prompt: 'Be formal.', rev: 6 });
});

async function ask(text: string) {
    await fireEvent.changeText(await screen.findByLabelText('Chat message'), text);
    await fireEvent.press(screen.getByLabelText('Send message'));
}

describe('AgentRefineScreen', () => {
    it('refines, snapshots, saves the merge once and says what changed', async () => {
        await wrap(<AgentRefineScreen id="a1" />);
        expect(await screen.findByText('Refine this agent with AI')).toBeTruthy();
        await ask('Make it formal and add web search');

        expect(await screen.findByText('Done')).toBeTruthy();
        const calls = (api.post as jest.Mock).mock.calls.map((c) => c[0]);
        expect(calls).toEqual(['/agents/wizard/refine', '/versions/a1/pre-refine']);
        const refineBody = (api.post as jest.Mock).mock.calls[0][1];
        expect(refineBody).toMatchObject({ refinement: 'Make it formal and add web search', current: { model: 'tier:fast', knowledge_base_ids: ['kb1'] } });

        expect(api.put).toHaveBeenCalledTimes(1);
        const body = (api.put as jest.Mock).mock.calls[0][1];
        // The empty KB list in the plan kept the curated one; apps were replaced.
        expect(body).toMatchObject({ systemPrompt: 'Be formal.', baseVersion: 5, config: { knowledge_base_ids: ['kb1'], enabledIntegrations: ['agent-search'] } });
        expect(screen.getByText('· Rewrote the instructions')).toBeTruthy();
        expect(screen.getByText('· Turned on 1 app')).toBeTruthy();
        expect(screen.getByText('· Turned off 1 app')).toBeTruthy();
    });

    it('undoes by restoring the pre-refine version', async () => {
        await wrap(<AgentRefineScreen id="a1" />);
        await ask('Shorter answers');
        await fireEvent.press(await screen.findByText('Undo'));
        expect(await screen.findByText('Undone')).toBeTruthy();
        expect(api.post).toHaveBeenCalledWith('/versions/a1/v1/restore', undefined, { retry: false });
    });

    it('says a malformed plan in the web words and saves nothing', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('bad', { status: 422, body: { reason: 'plan_parse_failed' } }));
        await wrap(<AgentRefineScreen id="a1" />);
        await ask('Anything');
        expect(await screen.findByText('The assistant returned malformed output. Please try again.')).toBeTruthy();
        expect(api.put).not.toHaveBeenCalled();
    });

    it('fires the ask handed over by Create with AI once', async () => {
        await wrap(<AgentRefineScreen id="a1" q="A helpdesk for IT" />);
        expect(await screen.findByText('Done')).toBeTruthy();
        const refines = (api.post as jest.Mock).mock.calls.filter((c) => c[0] === '/agents/wizard/refine');
        expect(refines).toHaveLength(1);
        expect(refines[0][1]).toMatchObject({ prompt: 'A helpdesk for IT', refinement: 'A helpdesk for IT' });
    });
});
