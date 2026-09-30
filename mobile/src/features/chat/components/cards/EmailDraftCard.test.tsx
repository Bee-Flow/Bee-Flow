/** An e-mail draft is sent only when a person presses Send, and says what happened. */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { _resetDraftActions } from '@/features/chat/hooks/useDraftAction';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { EmailDraftCard } from './EmailDraftCard';

const mockSend = jest.fn();
const mockSave = jest.fn();
jest.mock('@/features/chat/api/drafts', () => ({
    sendEmailDraft: (...args: unknown[]) => mockSend(...args),
    saveEmailDraft: (...args: unknown[]) => mockSave(...args),
}));

const DRAFT = { to: 'anna@example.nl', subject: 'Offerte', body: 'Beste Anna, …', status: 'pending' };

beforeEach(() => {
    _resetDraftActions();
    mockSend.mockReset();
    mockSave.mockReset();
});

it('shows the draft and sends it on Send', async () => {
    mockSend.mockResolvedValue(undefined);
    await renderScreen(<EmailDraftCard draft={DRAFT} draftKey="m1:email:0" />);
    expect(screen.getByText('EMAIL DRAFT — AWAITING APPROVAL')).toBeTruthy();
    expect(screen.getByText('anna@example.nl')).toBeTruthy();
    await fireEvent.press(screen.getByText('Send Email'));
    await waitFor(() => expect(screen.getByText('EMAIL SENT ✓')).toBeTruthy());
    expect(mockSend).toHaveBeenCalledWith(DRAFT);
    expect(screen.queryByText('Discard')).toBeNull();
});

it("keeps the server's reason when it refuses", async () => {
    mockSend.mockRejectedValue(new Error('Gmail is not connected'));
    await renderScreen(<EmailDraftCard draft={DRAFT} draftKey="m1:email:1" />);
    await fireEvent.press(screen.getByText('Send Email'));
    await waitFor(() => expect(screen.getByText('Error: Gmail is not connected')).toBeTruthy());
    expect(screen.getByText('SEND FAILED')).toBeTruthy();
});

it('discards without calling anything', async () => {
    await renderScreen(<EmailDraftCard draft={DRAFT} draftKey="m1:email:2" />);
    await fireEvent.press(screen.getByText('Discard'));
    expect(screen.getByText('EMAIL DISCARDED')).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
});
