/**
 * One skill, rendered against canned answers: the Studio header and its four
 * sections, the method drawn from the STRUCTURE (steps, rules, delivers), an
 * edit saved as structure, a read-only viewer told why, and the used-by list.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { SkillScreen } from './SkillScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', isAdmin: false } }) }));

const SKILL = {
    id: 'sk1',
    orgId: 'org1',
    userId: 'u1',
    name: 'Quote answers',
    description: 'Answers questions about quotes',
    instructions: 'Use when a customer asks about a quote',
    icon: '💬',
    canEdit: true,
    steps: [{ id: 's1', text: 'Look up the quote', refs: [{ kind: 'kb', id: 'kb1' }] }],
    rulesV2: [{ id: 'r1', polarity: 'never', text: 'Never promise a date' }],
    examplesV2: [{ id: 'e1', question: 'Where is my quote?', good: 'It went out Monday.' }],
    outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    knowledgeBaseIds: ['kb1'],
};

let answers: Record<string, unknown>;

beforeEach(() => {
    answers = {
        '/api/skills/sk1': SKILL,
        '/api/skills/sk1/usage': { usage: [{ kind: 'agent', id: 'a1', title: 'Sales bot', role: 'chat' }], unchecked: [] },
        '/api/kb?context=agent': [{ id: 'kb1', name: 'Price list' }],
        '/api/automation': { automations: [] },
        '/api/datatables': { datatables: [] },
    };
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? null));
    (api.put as jest.Mock).mockResolvedValue({ success: true });
});

const wrap = (ui: ReactElement) => renderWithProviders(<ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider>);

describe('SkillScreen', () => {
    it('opens on the method, drawn from the structure', async () => {
        await wrap(<SkillScreen skillId="sk1" />);
        expect(await screen.findByText('Quote answers')).toBeTruthy();
        for (const text of ['Method', 'Examples', 'Test', 'Used by', 'Improve with AI', 'Steps', 'Rules', 'Delivers', 'total']) {
            expect(screen.getAllByText(text).length).toBeGreaterThan(0);
        }
        expect(screen.getByDisplayValue('Look up the quote')).toBeTruthy();
        expect(screen.getByDisplayValue('Never promise a date')).toBeTruthy();
        expect((await screen.findAllByText('Price list')).length).toBe(2);
    });

    it('saves an edit as structure, never as text', async () => {
        await wrap(<SkillScreen skillId="sk1" />);
        const field = await screen.findByDisplayValue('Look up the quote');
        await fireEvent.changeText(field, 'Look up the quote in the CRM');
        expect(await screen.findByText('Saving…')).toBeTruthy();
        // The autosave waits for a pause in typing before it sends.
        await waitFor(() => expect(api.put).toHaveBeenCalled(), { timeout: 3000 });
        expect(await screen.findByText('Saved')).toBeTruthy();
        const [path, body] = (api.put as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
        expect(path).toBe('/api/skills/sk1');
        expect(body.steps).toEqual([{ id: 's1', text: 'Look up the quote in the CRM', refs: [{ kind: 'kb', id: 'kb1' }] }]);
        expect(body).not.toHaveProperty('workflow');
    });

    it('tells a viewer who may not edit why, and offers no primary action', async () => {
        answers['/api/skills/sk1'] = { ...SKILL, canEdit: false };
        await wrap(<SkillScreen skillId="sk1" />);
        expect(await screen.findByText(/You can see this skill but not change it/)).toBeTruthy();
        expect(screen.queryByText('Improve with AI')).toBeNull();
        expect(screen.getByText('Read-only')).toBeTruthy();
    });

    it('lists what uses the skill on the Used by tab', async () => {
        await wrap(<SkillScreen skillId="sk1" />);
        await fireEvent.press(await screen.findByLabelText('Used by, 1'));
        expect(await screen.findByText('Sales bot')).toBeTruthy();
        expect(screen.getByText('Delete skill')).toBeTruthy();
    });

    it('shows the examples on their own tab', async () => {
        await wrap(<SkillScreen skillId="sk1" />);
        await fireEvent.press(await screen.findByLabelText('Examples, 1'));
        expect(await screen.findByDisplayValue('Where is my quote?')).toBeTruthy();
        expect(screen.getByText('Pick from a conversation')).toBeTruthy();
    });
});
