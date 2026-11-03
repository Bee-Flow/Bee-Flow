/** The inbox marks a test run's approval: it went to the tester only, and deciding it moves nothing in production. */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ApprovalRow } from './ApprovalRow';
import { readApproval } from '../api/readers';

const row = (extra: Record<string, unknown>) => readApproval({ id: 'ap1', prompt: 'Refund order 42?', status: 'pending', createdAt: '2026-11-03T09:00:00Z', ...extra });

describe('ApprovalRow', () => {
    it('wears a Test chip on a test run’s approval', async () => {
        await renderScreen(<ApprovalRow approval={row({ isTest: true })} onPress={jest.fn()} />);
        expect(screen.getByTestId('approval-test-chip')).toBeTruthy();
        expect(screen.getByText('Test')).toBeTruthy();
    });

    it('has none on a production approval, nor from an older server', async () => {
        await renderScreen(<ApprovalRow approval={row({})} onPress={jest.fn()} />);
        expect(screen.queryByTestId('approval-test-chip')).toBeNull();
    });

    it('keeps the settled state next to the chip', async () => {
        await renderScreen(<ApprovalRow approval={row({ isTest: true, status: 'approved' })} onPress={jest.fn()} />);
        expect(screen.getByText('Test')).toBeTruthy();
        expect(screen.getByText('Approved')).toBeTruthy();
    });
});
