import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { DsrRequestsGroup } from './DsrRequestsGroup';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const REQUEST = { id: 42, status: 'pending', request_type: 'access', subject_email: 'j***@example.com', created_at: '2026-09-01T10:00:00Z' };

beforeEach(() => mockPush.mockClear());

it('opens a request in the native Compliance Center', async () => {
    await renderWithProviders(<DsrRequestsGroup requests={[REQUEST]} loading={false} />);
    fireEvent.press(screen.getByTestId('dsr-request-42'));
    expect(mockPush).toHaveBeenCalledWith('/org/compliance/dsr/42');
});

it('opens the whole register, even when nothing is filed', async () => {
    await renderWithProviders(<DsrRequestsGroup requests={[]} loading={false} />);
    expect(screen.getByText('No requests have been filed.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('dsr-open-register'));
    expect(mockPush).toHaveBeenCalledWith('/org/compliance/dsr');
});
