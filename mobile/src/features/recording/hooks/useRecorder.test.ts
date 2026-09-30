/**
 * The recorder hook: the only copy of a meeting passes through it, so each
 * way a capture can end is pinned — stopped (the file is moved somewhere
 * durable and named), discarded (the file is deleted), refused (no permission,
 * nothing touched) and failed (the session is released and the reason shown).
 * The meter's polling and the quiet-mic verdict are driven with fake timers.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

import { useRecorder, type RecorderOptions } from './useRecorder';
import { readJournal } from '../model/journal';

const mockAudio = {
    status: { durationMillis: 0, metering: -60 as number | undefined },
    uri: 'file:///cache/raw.m4a' as string | null,
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(async () => {}),
    getStatus() {
        return { ...mockAudio.status };
    },
};
const mockPermission = { granted: true, canAskAgain: true };
const mockSetAudioMode = jest.fn(async (_mode: Record<string, unknown>) => {});
const mockRequestPermission = jest.fn(async () => ({ ...mockPermission }));

jest.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    getRecordingPermissionsAsync: async () => ({ ...mockPermission }),
    requestRecordingPermissionsAsync: () => mockRequestPermission(),
    setAudioModeAsync: (mode: Record<string, unknown>) => mockSetAudioMode(mode),
    useAudioRecorder: (_options: unknown, listener: (status: Record<string, unknown>) => void) => {
        mockStatusListener.current = listener;
        return mockAudio;
    },
}));
const mockStatusListener: { current: ((status: Record<string, unknown>) => void) | null } = { current: null };

const mockKeepAwake = { active: false };
jest.mock('expo-keep-awake', () => ({
    activateKeepAwakeAsync: async () => {
        mockKeepAwake.active = true;
    },
    deactivateKeepAwake: async () => {
        mockKeepAwake.active = false;
    },
}));

/** The file system as a set of existing uris, and a log of what moved where. */
const mockFs = { files: new Set<string>(), moves: [] as [string, string][], deleted: [] as string[] };
jest.mock('expo-file-system', () => {
    class Directory {
        uri: string;
        constructor(parent: { uri: string } | string, name: string) {
            this.uri = `${typeof parent === 'string' ? parent : parent.uri}/${name}`;
        }
        get exists() {
            return true;
        }
        create() {}
    }
    class File {
        uri: string;
        constructor(parent: { uri: string } | string, name?: string) {
            const base = typeof parent === 'string' ? parent : parent.uri;
            this.uri = name ? `${base}/${name}` : base;
        }
        get exists() {
            return mockFs.files.has(this.uri);
        }
        get size() {
            return 1234;
        }
        moveSync(destination: { uri: string }) {
            mockFs.moves.push([this.uri, destination.uri]);
            mockFs.files.delete(this.uri);
            mockFs.files.add(destination.uri);
        }
        delete() {
            mockFs.deleted.push(this.uri);
            mockFs.files.delete(this.uri);
        }
    }
    return { Directory, File, Paths: { document: { uri: 'file:///doc' } } };
});

beforeEach(async () => {
    await AsyncStorage.clear();
    jest.useFakeTimers();
    Object.assign(mockPermission, { granted: true, canAskAgain: true });
    mockAudio.status = { durationMillis: 0, metering: -60 };
    mockAudio.uri = 'file:///cache/raw.m4a';
    mockAudio.prepareToRecordAsync.mockReset();
    mockAudio.record.mockReset();
    mockAudio.pause.mockReset();
    mockAudio.stop.mockReset();
    mockSetAudioMode.mockClear();
    mockRequestPermission.mockClear();
    mockKeepAwake.active = false;
    mockFs.files = new Set(['file:///cache/raw.m4a']);
    mockFs.moves = [];
    mockFs.deleted = [];
});

afterEach(() => {
    jest.useRealTimers();
});

async function started(onInterrupted?: RecorderOptions['onInterrupted']) {
    const hook = await renderHook(() => useRecorder({ onInterrupted }));
    let ok = false;
    await act(async () => {
        ok = await hook.result.current.start();
    });
    return { ...hook, ok };
}

describe('useRecorder', () => {
    it('refuses to start without the microphone permission and touches nothing', async () => {
        mockPermission.granted = false;
        const { result, ok } = await started();
        expect(ok).toBe(false);
        expect(result.current.phase).toBe('idle');
        expect(result.current.permission).toEqual({ granted: false, canAskAgain: true, unknown: false });
        expect(mockSetAudioMode).not.toHaveBeenCalled();
        expect(mockAudio.record).not.toHaveBeenCalled();
    });

    it('starts a background-capable capture and holds the wake lock', async () => {
        const { result, ok } = await started();
        expect(ok).toBe(true);
        expect(result.current.phase).toBe('recording');
        expect(result.current.active).toBe(true);
        expect(mockSetAudioMode).toHaveBeenCalledWith(
            expect.objectContaining({ allowsRecording: true, allowsBackgroundRecording: true, interruptionMode: 'doNotMix' }),
        );
        expect(mockAudio.prepareToRecordAsync).toHaveBeenCalledTimes(1);
        expect(mockAudio.record).toHaveBeenCalledTimes(1);
        expect(mockKeepAwake.active).toBe(true);
    });

    it('polls the level and the clock while recording, and says so when the room goes quiet', async () => {
        const { result } = await started();
        mockAudio.status = { durationMillis: 2500, metering: -10 };
        await act(async () => {
            jest.advanceTimersByTime(100);
        });
        expect(result.current.elapsed).toBe(2.5);
        expect(result.current.history.at(-1)).toBeGreaterThan(0.8);
        expect(result.current.history).toHaveLength(40);
        expect(result.current.quiet).toBe(false);

        // Forty near-silent samples (about four seconds) before it cries wolf.
        mockAudio.status = { durationMillis: 3000, metering: -70 };
        await act(async () => {
            jest.advanceTimersByTime(3900);
        });
        expect(result.current.quiet).toBe(false);
        await act(async () => {
            jest.advanceTimersByTime(100);
        });
        expect(result.current.quiet).toBe(true);

        // One loud sample clears it.
        mockAudio.status = { durationMillis: 3100, metering: -5 };
        await act(async () => {
            jest.advanceTimersByTime(100);
        });
        expect(result.current.quiet).toBe(false);
    });

    it('freezes the clock on pause and carries on after resume', async () => {
        const { result } = await started();
        mockAudio.status = { durationMillis: 4000, metering: -20 };
        await act(async () => {
            result.current.pause();
        });
        expect(result.current.phase).toBe('paused');
        expect(result.current.elapsed).toBe(4);
        expect(result.current.history.every((level) => level === 0)).toBe(true);

        mockAudio.status = { durationMillis: 9000, metering: -20 };
        await act(async () => {
            jest.advanceTimersByTime(1000);
        });
        expect(result.current.elapsed).toBe(4);

        await act(async () => {
            result.current.resume();
        });
        expect(result.current.phase).toBe('recording');
        await act(async () => {
            jest.advanceTimersByTime(100);
        });
        expect(result.current.elapsed).toBe(9);
    });

    it('stops into a named file in the document directory and releases the session', async () => {
        const { result } = await started();
        mockAudio.status = { durationMillis: 61_000, metering: -20 };
        let captured: Awaited<ReturnType<typeof result.current.stop>> = null;
        await act(async () => {
            captured = await result.current.stop();
        });
        expect(captured).toEqual({
            uri: expect.stringMatching(/^file:\/\/\/doc\/recordings\/Meeting \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.m4a$/),
            fileName: expect.stringMatching(/^Meeting .*\.m4a$/),
            mimeType: 'audio/mp4',
            sizeBytes: 1234,
            durationSeconds: 61,
        });
        expect(mockFs.moves).toHaveLength(1);
        expect(result.current.phase).toBe('idle');
        expect(result.current.active).toBe(false);
        expect(mockKeepAwake.active).toBe(false);
        expect(mockSetAudioMode).toHaveBeenLastCalledWith({ allowsRecording: false, allowsBackgroundRecording: false });
    });

    it('says so when a stop produced no file', async () => {
        const { result } = await started();
        mockAudio.uri = null;
        let captured: unknown = 'unset';
        await act(async () => {
            captured = await result.current.stop();
        });
        expect(captured).toBeNull();
        expect(result.current.error).toBe('The recording finished but produced no file.');
        expect(result.current.phase).toBe('idle');
    });

    it('does nothing on stop when nothing is being recorded', async () => {
        const { result } = await renderHook(() => useRecorder());
        let captured: unknown = 'unset';
        await act(async () => {
            captured = await result.current.stop();
        });
        expect(captured).toBeNull();
        expect(mockAudio.stop).not.toHaveBeenCalled();
    });

    it('discards by deleting the file and resetting the clock', async () => {
        const { result } = await started();
        mockAudio.status = { durationMillis: 5000, metering: -20 };
        await act(async () => {
            jest.advanceTimersByTime(100);
        });
        await act(async () => {
            await result.current.discard();
        });
        expect(mockFs.deleted).toEqual(['file:///cache/raw.m4a']);
        expect(result.current.phase).toBe('idle');
        expect(result.current.elapsed).toBe(0);
        expect(mockKeepAwake.active).toBe(false);
    });

    it('releases the session and shows the reason when the microphone cannot start', async () => {
        mockAudio.prepareToRecordAsync.mockRejectedValueOnce(new Error('Mic busy'));
        const { result, ok } = await started();
        expect(ok).toBe(false);
        expect(result.current.phase).toBe('idle');
        expect(result.current.error).toBe('Mic busy');
        expect(mockSetAudioMode).toHaveBeenLastCalledWith({ allowsRecording: false, allowsBackgroundRecording: false });

        await act(async () => {
            result.current.clearError();
        });
        expect(result.current.error).toBeNull();
    });

    it('treats a failed permission request as a refusal that cannot be asked again', async () => {
        mockRequestPermission.mockRejectedValueOnce(new Error('No activity'));
        const { result } = await renderHook(() => useRecorder());
        let state: unknown;
        await act(async () => {
            state = await result.current.requestPermission();
        });
        expect(state).toEqual({ granted: false, canAskAgain: false, unknown: false });
        expect(result.current.error).toBe('No activity');
    });

    it('records AAC in ADTS on Android, which survives being cut off', async () => {
        await started();
        expect(mockAudio.prepareToRecordAsync).toHaveBeenCalledWith(
            expect.objectContaining({ android: { extension: '.aac', outputFormat: 'aac_adts', audioEncoder: 'aac' } }),
        );
    });

    it('journals the file before recording, follows it on stop, and forgets it on discard', async () => {
        const { result } = await started();
        expect(await readJournal()).toEqual(
            expect.objectContaining({ uri: 'file:///cache/raw.m4a', settings: { extension: '.aac', bitRate: 64000 } }),
        );
        let captured: Awaited<ReturnType<typeof result.current.stop>> = null;
        await act(async () => {
            captured = await result.current.stop();
        });
        // Still journalled at its new home: the outbox, not the recorder, closes it.
        expect((await readJournal())?.uri).toBe((captured as { uri: string } | null)?.uri);
        expect(result.current.owns((captured as unknown as { uri: string }).uri)).toBe(true);

        mockFs.files.add('file:///cache/raw.m4a');
        await act(async () => {
            await result.current.start();
        });
        await act(async () => {
            await result.current.discard();
        });
        expect(await readJournal()).toBeNull();
    });

    it('keeps what was recorded when the system ends the recording, and says so', async () => {
        const onInterrupted = jest.fn();
        const { result } = await started(onInterrupted);
        await act(async () => {
            mockStatusListener.current?.({ isFinished: true, hasError: true, error: 'The media server has crashed', url: null });
        });
        expect(result.current.phase).toBe('idle');
        expect(mockAudio.stop).toHaveBeenCalled();
        expect(mockKeepAwake.active).toBe(false);
        expect(onInterrupted).toHaveBeenCalledWith(
            expect.objectContaining({ uri: expect.stringMatching(/^file:\/\/\/doc\/recordings\/Meeting /) }),
            'The media server has crashed',
        );
        expect(mockFs.deleted).toEqual([]);
    });

    it('does not mistake its own stop for an interruption', async () => {
        const onInterrupted = jest.fn();
        const { result } = await started(onInterrupted);
        await act(async () => {
            await result.current.stop();
            mockStatusListener.current?.({ isFinished: true, hasError: false, error: null, url: 'file:///cache/raw.m4a' });
        });
        expect(onInterrupted).not.toHaveBeenCalled();
    });
});
