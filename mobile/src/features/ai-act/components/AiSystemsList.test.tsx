/**
 * AI Act › Systems: one row per declaration with its outcome words, Reassess
 * once lapsed, a tap opens the ladder for that kind and id, and the empty and
 * failed states say what the web says.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AiSystemsList } from './AiSystemsList';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const LIST = '/api/compliance/ai-act/assessments';
const ROWS = [
    { target_kind: 'agent', target_id: 'g1', title: 'Helpdesk', outcome: 'transparency', attested_at: '2026-09-01T10:00:00Z', expires_at: '2027-09-01T10:00:00Z', current: true },
    { target_kind: 'automation', target_id: 'a1', title: null, outcome: 'prohibited', attested_at: '2025-01-01T10:00:00Z', expires_at: '2026-01-01T10:00:00Z', current: false },
    { target_kind: 'automation', target_id: 'a2', title: 'Evergreen', outcome: 'not_applicable', attested_at: '2026-09-01T10:00:00Z', expires_at: null, current: true },
];

beforeEach(() => jest.clearAllMocks());

it('lists each declaration with its outcome, validity and action', async () => {
    (api.get as jest.Mock).mockImplementation(async (path: string) => (path === LIST ? ROWS : null));
    await renderScreen(<AiSystemsList />);
    expect(await screen.findByText('Helpdesk')).toBeTruthy();
    expect(screen.getByText('Art. 4 + Art. 50')).toBeTruthy();
    expect(screen.getByText('Prohibited (Art. 5)')).toBeTruthy();
    expect(screen.getByText('AI Act not applicable')).toBeTruthy();
    expect(screen.getByText('a1')).toBeTruthy();
    expect(screen.getByText(/Expired$/)).toBeTruthy();
    expect(screen.getByText(/does not expire$/)).toBeTruthy();
    expect(screen.getByText('Reassess')).toBeTruthy();
    expect(screen.getAllByText('Open')).toHaveLength(2);
});

it('opens the ladder for the tapped row', async () => {
    (api.get as jest.Mock).mockImplementation(async (path: string) => (path === LIST ? ROWS : { outcome: null, signals: {}, answers: null }));
    await renderScreen(<AiSystemsList />);
    await fireEvent.press(await screen.findByTestId('ai-systems-row-agent:g1'));
    expect(await screen.findByText('Does the AI Act apply to this agent?')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/api/compliance/ai-act/assessments/agent/g1');
});

it('says so when there are none', async () => {
    (api.get as jest.Mock).mockResolvedValue([]);
    await renderScreen(<AiSystemsList />);
    expect(await screen.findByText('No assessments yet')).toBeTruthy();
});

it('says so when they could not be read', async () => {
    (api.get as jest.Mock).mockRejectedValue(new ApiError('Boom', { status: 500 }));
    await renderScreen(<AiSystemsList />);
    expect(await screen.findByText('The AI Act assessments could not be read.')).toBeTruthy();
});
