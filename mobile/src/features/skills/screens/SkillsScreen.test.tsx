/**
 * The skill library against canned answers: the web's sublines ("2 agents",
 * "draft · empty", "not tested"), sorted by use, re-sorted by name, and the
 * AI draft prefilling a new skill that is then created with its structure.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { SkillsScreen } from './SkillsScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', isAdmin: false } }) }));
jest.mock('@/core/access', () => ({ useHasPermission: () => true }));

const ANSWERS: Record<string, unknown> = {
    '/api/skills': [
        { id: 'a', name: 'Alpha', description: 'First', steps: [{ id: 's', text: 'x' }], lastTest: { status: 'ok', adviceCount: 0 } },
        { id: 'b', name: 'Beta', description: 'Second', steps: [{ id: 's', text: 'x' }], rulesV2: [{ id: 'r', text: 'y' }] },
        { id: 'c', name: 'Empty one', description: '' },
    ],
    '/api/skills/usage-summary': { summary: { a: { agents: 0, automations: 0 }, b: { agents: 2, automations: 1 } } },
};

beforeEach(() => {
    mockPush.mockReset();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

const render = () => renderWithProviders(<ToastProvider><ConfirmProvider><SkillsScreen /></ConfirmProvider></ToastProvider>);

describe('SkillsScreen', () => {
    it('lists every skill with the web’s sublines, most used first', async () => {
        await render();
        expect(await screen.findByText('2 agents · 1 automation · 1 step · 1 rule · 0 examples')).toBeTruthy();
        expect(screen.getByText('not linked yet · 1 step · 0 rules · 0 examples')).toBeTruthy();
        expect(screen.getByText('draft · empty')).toBeTruthy();
        expect(screen.getByText('ok')).toBeTruthy();
        const names = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel).filter((l) => ['Alpha', 'Beta', 'Empty one'].includes(l));
        expect(names).toEqual(['Beta', 'Alpha', 'Empty one']);
    });

    it('sorts by name on request', async () => {
        await render();
        await screen.findByText('draft · empty');
        await fireEvent.press(screen.getByText('name'));
        const names = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel).filter((l) => ['Alpha', 'Beta', 'Empty one'].includes(l));
        expect(names).toEqual(['Alpha', 'Beta', 'Empty one']);
    });

    it('drafts a new skill with AI and creates it with its structure', async () => {
        (api.post as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/skills/ai/draft'
                    ? { draft: { name: 'Quote answers', description: 'Answers quote questions', steps: [{ id: 's1', text: 'Look up' }], rulesV2: [] } }
                    : { id: 'new1', name: 'Quote answers' },
            ),
        );
        await render();
        await fireEvent.press(await screen.findByLabelText('Create skill'));
        await fireEvent.changeText(await screen.findByLabelText('What should this skill do?'), 'Answer questions about quotes');
        await fireEvent.press(screen.getByTestId('skill-fill-in-run'));
        const preview = await screen.findByTestId('skill-draft-preview');
        expect(within(preview).getByText('Answers quote questions')).toBeTruthy();
        expect(screen.getByDisplayValue('Quote answers')).toBeTruthy();
        await fireEvent.press(screen.getAllByText('Create skill').at(-1)!);
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/skills/new1'));
        const created = (api.post as jest.Mock).mock.calls.find(([p]) => p === '/api/skills')?.[1];
        expect(created).toMatchObject({ name: 'Quote answers', icon: '⚡', steps: [{ id: 's1', text: 'Look up', refs: [] }] });
        expect(created).not.toHaveProperty('workflow');
    });
});
