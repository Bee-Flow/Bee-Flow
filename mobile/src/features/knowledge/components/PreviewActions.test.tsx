/**
 * The preview's file button says what it does: it hands the file to Android's
 * share sheet, so it reads "Share or save…", not "Open with…".
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { PreviewActions } from './PreviewActions';

it('offers a file to the share sheet under a label that says so', async () => {
    const onOpenWith = jest.fn();
    await renderWithProviders(<PreviewActions onOpenWith={onOpenWith} busy={false} />);
    expect(screen.queryByText('Open with…')).toBeNull();
    await fireEvent.press(screen.getByText('Share or save…'));
    expect(onOpenWith).toHaveBeenCalledTimes(1);
});

it('offers text to share', async () => {
    const onShare = jest.fn();
    await renderWithProviders(<PreviewActions onShare={onShare} busy={false} />);
    await fireEvent.press(screen.getByText('Share'));
    expect(onShare).toHaveBeenCalledTimes(1);
});
