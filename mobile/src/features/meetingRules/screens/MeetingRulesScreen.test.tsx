/**
 * The rules screen: a rule as its sentence with the reader's run count, a
 * licence refusal worded as one, and "Rule" creating a draft that opens.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { MeetingRulesScreen } from './MeetingRulesScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const RULE = {
    id: 'r1',
    title: 'File sales notes',
    userId: 'me',
    isActive: true,
    isDraft: false,
    definition: {
        trigger: { kind: 'app_event', appEvent: { provider: 'meeting-notes', event: 'meeting.processed', filter: { tags: ['sales'] } } },
        steps: [{ type: 'knowledge_write' }],
    },
};

function answer({ rules, facets }: { rules: () => Promise<unknown>; facets?: unknown }) {
    (api.get as jest.Mock).mockImplementation((path: string) =>
        path === '/api/automation' ? rules() : Promise.resolve(facets ?? { facets: { automationId: { r1: 2 } }, rangeHours: 24 }),
    );
}


beforeEach(() => jest.clearAllMocks());

describe('MeetingRulesScreen', () => {
    it('reads a rule as a sentence with its runs', async () => {
        answer({ rules: () => Promise.resolve({ automations: [RULE] }) });
        await renderWithProviders(<MeetingRulesScreen />);
        expect(await screen.findByText('File sales notes')).toBeTruthy();
        expect(screen.getByText('When a meeting tagged sales is finished → files it in a knowledge base')).toBeTruthy();
        expect(await screen.findByText('2 runs of yours in the last 24 hours')).toBeTruthy();
        await fireEvent.press(screen.getByText('Open automation'));
        expect(mockPush).toHaveBeenCalledWith('/automations/r1');
        expect(api.get).toHaveBeenCalledWith('/api/automation', expect.objectContaining({ query: { triggerProvider: 'meeting-notes' } }));
    });

    it('says once that the counts are missing instead of showing zeros', async () => {
        answer({ rules: () => Promise.resolve({ automations: [RULE] }), facets: { rangeHours: 24 } });
        await renderWithProviders(<MeetingRulesScreen />);
        expect(await screen.findByText(/Couldn’t read how often these ran/)).toBeTruthy();
        expect(screen.queryByText(/runs? of yours/)).toBeNull();
    });

    it('words a licence refusal', async () => {
        answer({ rules: () => Promise.reject(new ApiError('feature_locked', { status: 403 })) });
        await renderWithProviders(<MeetingRulesScreen />);
        expect(await screen.findByText(/Automations are not part of this plan/)).toBeTruthy();
    });

    it('creates a draft rule and opens it', async () => {
        answer({ rules: () => Promise.resolve({ automations: [] }) });
        (api.post as jest.Mock).mockResolvedValue({ automation: { id: 'new1' } });
        await renderWithProviders(<MeetingRulesScreen />);
        expect(await screen.findByText('No rules yet')).toBeTruthy();
        await fireEvent.press(screen.getByText('Rule'));
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/automations/new1'));
        const [path, body] = (api.post as jest.Mock).mock.calls[0];
        expect(path).toBe('/api/automation');
        expect(body).toMatchObject({ triggerType: 'app_event', definition: { trigger: { kind: 'app_event' } } });
    });
});
