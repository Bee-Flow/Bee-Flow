/**
 * A generated clip has no player in this app: its button hands the file to
 * the share sheet and says "Share or save…", not "Download MP4". A failed
 * download says why.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OfflineError } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { VideoCard } from './VideoCard';

jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn() }));
jest.mock('@/core/api/server', () => ({ ...jest.requireActual('@/core/api/server'), getServerUrl: () => 'https://bee.example' }));

const CLIP = { url: '/api/storage/media/clip', mimeType: 'video/mp4' };

beforeEach(() => jest.mocked(shareServerFile).mockReset());

it('hands the clip to the share sheet under a label that says so', async () => {
    jest.mocked(shareServerFile).mockResolvedValue('file:///cache/video.mp4');
    await renderScreen(<VideoCard video={CLIP} />);
    expect(screen.queryByText('Download MP4')).toBeNull();
    await fireEvent.press(screen.getByText('Share or save…'));
    await waitFor(() =>
        expect(shareServerFile).toHaveBeenCalledWith('https://bee.example/api/storage/media/clip', 'video.mp4', 'video/mp4'),
    );
});

it('says why the download failed', async () => {
    jest.mocked(shareServerFile).mockRejectedValue(new OfflineError());
    await renderScreen(<VideoCard video={CLIP} />);
    await fireEvent.press(screen.getByText('Share or save…'));
    expect(await screen.findByText('Bee Flow will pick up where you left off once you are back on a network.')).toBeTruthy();
});
