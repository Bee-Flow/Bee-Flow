/**
 * Sharing: personal / whole organisation / groups, widening asks first, and a
 * group list that could not be read is never drawn as "no groups".
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AudienceSheet, type AudienceSheetProps } from './AudienceSheet';
import { ConfirmProvider } from './confirm';

jest.setTimeout(20_000);

const GROUPS = [{ id: 'g1', name: 'Sales' }, { id: 'g2', name: 'Support' }];

async function show(over: Partial<AudienceSheetProps> = {}) {
    const onChange = jest.fn();
    await renderWithProviders(
        <ConfirmProvider>
            <AudienceSheet
                visible
                onClose={jest.fn()}
                name="Price list"
                value={{ isShared: false, sharedGroups: [] }}
                groups={GROUPS}
                canShare
                onChange={onChange}
                {...over}
            />
        </ConfirmProvider>,
    );
    return onChange;
}

describe('AudienceSheet', () => {
    it('asks before sharing with the whole organisation', async () => {
        const onChange = await show();
        await fireEvent.press(screen.getByLabelText('Entire organisation'));
        expect(await screen.findByText('Everyone in your organisation will be able to see and use “Price list”.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Share'));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ isShared: true, sharedGroups: [] }));
    });

    it('narrows to personal without asking', async () => {
        const onChange = await show({ value: { isShared: true, sharedGroups: [] } });
        await fireEvent.press(screen.getByLabelText('Personal'));
        expect(onChange).toHaveBeenCalledWith({ isShared: false, sharedGroups: [] });
    });

    it('asks before sharing a personal object with a group', async () => {
        const onChange = await show();
        await fireEvent(screen.getByLabelText('Sales'), 'valueChange', true);
        expect(await screen.findByText('Members of Sales will be able to see and use “Price list”.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Share'));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ isShared: true, sharedGroups: ['g1'] }));
    });

    it('narrows the whole organisation to one group without asking', async () => {
        const onChange = await show({ value: { isShared: true, sharedGroups: [] } });
        await fireEvent(screen.getByLabelText('Sales'), 'valueChange', true);
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ isShared: true, sharedGroups: ['g1'] }));
        expect(screen.queryByText('Share more widely?')).toBeNull();
    });

    it('drops back to personal when the last group is switched off', async () => {
        const onChange = await show({ value: { isShared: true, sharedGroups: ['g1'] } });
        await fireEvent(screen.getByLabelText('Sales'), 'valueChange', false);
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ isShared: false, sharedGroups: [] }));
    });

    it('says a failed group read is not an empty organisation, and offers a retry', async () => {
        const retry = jest.fn();
        await show({ groups: null, onRetryGroups: retry });
        expect(screen.getByText(/could not be read/)).toBeTruthy();
        expect(screen.queryByText('No groups in this organisation yet.')).toBeNull();
        await fireEvent.press(screen.getByText('Try again'));
        expect(retry).toHaveBeenCalled();
    });

    it('offers nothing but personal without an organisation', async () => {
        await show({ canShare: false });
        expect(screen.queryByText('Or specific groups')).toBeNull();
    });
});
