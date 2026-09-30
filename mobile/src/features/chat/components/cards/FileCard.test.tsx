/**
 * A built file's button says what it does: this workspace's file goes to the
 * share sheet, so it reads "Share or save…" (not "Download", which the phone
 * never did); a file elsewhere opens in the browser and says so. A download
 * that fails says why, and a link that will not open says that.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { ApiError } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { FileCard } from './FileCard';

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn() }));
jest.mock('@/core/api/server', () => ({ ...jest.requireActual('@/core/api/server'), getServerUrl: () => 'https://bee.example' }));

const DECK = { url: '/api/storage/files/q3.pptx', name: 'q3.pptx', kind: 'presentation' };

let openURL: jest.SpyInstance;
beforeEach(() => {
    jest.mocked(shareServerFile).mockReset();
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});
afterEach(() => openURL.mockRestore());

it("offers this workspace's file to the share sheet, and says so", async () => {
    jest.mocked(shareServerFile).mockResolvedValue('file:///cache/q3.pptx');
    await renderScreen(<FileCard file={DECK} />);
    expect(screen.queryByText('Download')).toBeNull();
    await fireEvent.press(screen.getByText('Share or save…'));
    await waitFor(() => expect(shareServerFile).toHaveBeenCalledWith('https://bee.example/api/storage/files/q3.pptx', 'q3.pptx', undefined));
    expect(openURL).not.toHaveBeenCalled();
});

it('says why the download before the share sheet failed', async () => {
    jest.mocked(shareServerFile).mockRejectedValue(new ApiError('This file is gone. It may have expired.', { status: 404 }));
    await renderScreen(<FileCard file={DECK} />);
    await fireEvent.press(screen.getByText('Share or save…'));
    expect(await screen.findByText('This file is gone. It may have expired.')).toBeTruthy();
});

it('opens a file that lives elsewhere in the browser, and says that', async () => {
    await renderScreen(<FileCard file={{ url: 'https://files.example.org/deck.pptx', name: 'deck.pptx' }} />);
    await fireEvent.press(screen.getByText('Open in browser'));
    expect(openURL).toHaveBeenCalledWith('https://files.example.org/deck.pptx');
    expect(shareServerFile).not.toHaveBeenCalled();
});

it('says so when Nextcloud Office cannot be opened', async () => {
    openURL.mockRejectedValue(new Error('No activity found'));
    await renderScreen(<FileCard file={{ ...DECK, webUrl: 'https://cloud.example.org/office/q3' }} />);
    await fireEvent.press(screen.getByText('Open in Nextcloud Office'));
    expect(await screen.findByText('This link could not be opened on this phone.')).toBeTruthy();
});
