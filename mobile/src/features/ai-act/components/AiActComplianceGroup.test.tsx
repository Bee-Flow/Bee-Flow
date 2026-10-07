/**
 * The Compliance block's "Assess…": it opens the ladder natively, in a sheet
 * that starts from the saved assessment — no browser, no second sign-in —
 * and waits for that assessment before it can open at all.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AiActComplianceGroup } from './AiActComplianceGroup';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ useHasPermission: () => true }));

const PATH = '/api/compliance/ai-act/assessments/automation/a1';
const ROW = {
    outcome: 'minimal', attested_at: '2026-09-01T10:00:00Z', expires_at: '2099-01-01T00:00:00Z', current: true,
    signals: { contains_ai: true, customer_facing: false, generates_content: false, steps: { ai: [{ id: 's1', label: 'Classify' }] } },
    answers: { art5: { answer: 'no' }, annex_iii: { answer: 'no', domains: {} } },
};

beforeEach(() => jest.clearAllMocks());

it('opens the three-question ladder in a sheet, starting from the saved declaration', async () => {
    (api.get as jest.Mock).mockImplementation(async (path: string) => (path === PATH ? ROW : null));
    await renderScreen(<AiActComplianceGroup kind="automation" id="a1" />);
    expect(await screen.findByText('Minimal risk')).toBeTruthy();
    expect(screen.queryByText('Does the AI Act apply to this automation?')).toBeNull();

    await fireEvent.press(screen.getByTestId('flow-compliance-assess'));
    expect(screen.getByText('Does the AI Act apply to this automation?')).toBeTruthy();
    expect(screen.getByText('Art. 5 — prohibited practice?')).toBeTruthy();
    expect(screen.getByLabelText('no social scoring')).toBeChecked();

    await fireEvent.press(screen.getByTestId('ladder-later'));
    expect(screen.queryByText('Does the AI Act apply to this automation?')).toBeNull();
});

it('cannot assess before the saved assessment has been read', async () => {
    (api.get as jest.Mock).mockRejectedValue(new ApiError('Forbidden', { status: 403 }));
    await renderScreen(<AiActComplianceGroup kind="automation" id="a1" />);
    expect(await screen.findByText('The saved assessment could not be read.')).toBeTruthy();
    expect(screen.getByTestId('flow-compliance-assess')).toBeDisabled();
});
