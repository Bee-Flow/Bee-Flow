/**
 * The meeting player's hook: nothing downloads until play, a seek asked for
 * before the file existed lands once it has loaded, and a failed download is
 * kept as an error rather than thrown.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useAudioPlayer } from 'expo-audio';

import { useMeetingAudio } from './useMeetingAudio';
import { downloadMeetingAudio } from '../api/endpoints';

jest.mock('../api/endpoints', () => ({ downloadMeetingAudio: jest.fn() }));

type Listener = (status: { isLoaded: boolean }) => void;

function fakePlayer() {
    const listeners: Listener[] = [];
    return {
        isLoaded: false,
        listeners,
        play: jest.fn(),
        pause: jest.fn(),
        seekTo: jest.fn(async () => {}),
        setPlaybackRate: jest.fn(),
        addListener: jest.fn((_event: string, cb: Listener) => {
            listeners.push(cb);
            return { remove: jest.fn() };
        }),
    };
}

const download = downloadMeetingAudio as jest.Mock;
const hook = useAudioPlayer as jest.Mock;

let player: ReturnType<typeof fakePlayer>;

beforeEach(() => {
    jest.clearAllMocks();
    player = fakePlayer();
    hook.mockImplementation(() => player);
});

describe('useMeetingAudio', () => {
    it('downloads only when asked, then plays from the requested moment', async () => {
        download.mockResolvedValue('file:///cache/meeting-audio-m1');
        const { result } = await renderHook(() => useMeetingAudio('m1'));
        expect(download).not.toHaveBeenCalled();
        expect(result.current.phase).toBe('idle');

        await act(async () => result.current.seek(42));
        await waitFor(() => expect(result.current.phase).toBe('ready'));
        expect(hook).toHaveBeenLastCalledWith({ uri: 'file:///cache/meeting-audio-m1' }, { updateInterval: 250 });

        await act(async () => player.listeners.forEach((cb) => cb({ isLoaded: true })));
        expect(player.seekTo).toHaveBeenCalledWith(42);
        await waitFor(() => expect(player.play).toHaveBeenCalled());
    });

    it('plays and pauses once loaded, and cycles the speed', async () => {
        download.mockResolvedValue('file:///a');
        player.isLoaded = true;
        const { result } = await renderHook(() => useMeetingAudio('m1'));
        await act(async () => result.current.toggle(false));
        await waitFor(() => expect(result.current.phase).toBe('ready'));
        await act(async () => result.current.toggle(true));
        expect(player.pause).toHaveBeenCalled();
        await act(async () => result.current.cycleRate());
        expect(result.current.rate).toBe(1.25);
        expect(player.setPlaybackRate).toHaveBeenLastCalledWith(1.25);
    });

    it('keeps a failed download as an error', async () => {
        download.mockRejectedValue(new Error('Audio file not available'));
        const { result } = await renderHook(() => useMeetingAudio('m1'));
        await act(async () => result.current.toggle(false));
        expect(result.current.phase).toBe('error');
        expect((result.current.error as Error).message).toBe('Audio file not available');
    });

    it('aborts the download when the note is left', async () => {
        download.mockImplementation(() => new Promise(() => undefined));
        const { result, unmount } = await renderHook(() => useMeetingAudio('m1'));
        await act(async () => result.current.toggle(false));
        const signal = download.mock.calls[0][1] as AbortSignal;
        expect(signal.aborted).toBe(false);
        await act(async () => unmount());
        expect(signal.aborted).toBe(true);
    });
});
