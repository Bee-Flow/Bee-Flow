/**
 * The outbox holds the only copy of a meeting until the server says 202, so
 * each promise its header makes is pinned: an entry leaves only on an
 * acknowledged upload, a failure keeps the entry and the file with a reason, a
 * cancel is not a failure, the queue survives a restart (minus rows whose
 * file is gone), and "upload all" goes one at a time, oldest first.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError } from '@/core/api/client';

import { useOutbox, type NewPendingRecording } from './outbox';
import { uploadRecording } from '../api/upload';

jest.mock('../api/upload', () => ({ uploadRecording: jest.fn() }));

const mockFiles = new Set<string>();
jest.mock('expo-file-system', () => ({
    File: class {
        uri: string;
        constructor(uri: string) {
            this.uri = uri;
        }
        get exists() {
            return mockFiles.has(this.uri);
        }
        delete() {
            mockFiles.delete(this.uri);
        }
    },
}));

const upload = uploadRecording as jest.Mock;
const STORAGE_KEY = 'beeflow.recordings.outbox.v1';

function recording(name: string): NewPendingRecording {
    const uri = `file:///doc/recordings/${name}.m4a`;
    mockFiles.add(uri);
    return {
        uri,
        fileName: `${name}.m4a`,
        mimeType: 'audio/mp4',
        sizeBytes: 100,
        durationSeconds: 60,
        captureMode: 'recording',
        settings: { title: name, language: 'nl', attendees: '', contextTerms: '', numSpeakers: '' },
    };
}

async function stored(): Promise<unknown[]> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown[]) : [];
}

beforeEach(async () => {
    upload.mockReset();
    mockFiles.clear();
    await AsyncStorage.clear();
    useOutbox.setState({ items: [], hydrated: false });
});

describe('the outbox', () => {
    it('queues a recording at the top and persists it without its transient fields', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        expect(entry).toMatchObject({ status: 'queued', progress: 0, attempts: 0, error: null });
        expect(useOutbox.getState().items.map((i) => i.id)).toEqual([entry.id]);
        const [saved] = (await stored()) as Record<string, unknown>[];
        expect(saved).toMatchObject({ id: entry.id, status: 'queued' });
        expect(saved).not.toHaveProperty('progress');
    });

    it('removes the entry and the file only once the server has accepted it', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        upload.mockImplementationOnce(async (_input, opts: { onProgress: (e: { fraction: number }) => void }) => {
            opts.onProgress({ fraction: 0.5 });
            expect(useOutbox.getState().items[0]).toMatchObject({ status: 'uploading', progress: 0.5 });
            expect(mockFiles.has(entry.uri)).toBe(true);
            return { id: 'note-1', status: 'processing', title: 'a' };
        });
        const onAccepted = jest.fn();
        await useOutbox.getState().upload(entry.id, onAccepted);
        expect(upload).toHaveBeenCalledWith(
            expect.objectContaining({ uri: entry.uri, captureMode: 'recording', settings: entry.settings }),
            expect.anything(),
        );
        expect(onAccepted).toHaveBeenCalledWith({ id: 'note-1', status: 'processing', title: 'a' });
        expect(useOutbox.getState().items).toEqual([]);
        expect(mockFiles.has(entry.uri)).toBe(false);
        expect(await stored()).toEqual([]);
    });

    it('keeps a failed upload, its file and a reason, and counts the attempt', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        upload.mockRejectedValueOnce(new ApiError('The connection dropped', { status: 0 }));
        await useOutbox.getState().upload(entry.id);
        const [failed] = useOutbox.getState().items;
        expect(failed).toMatchObject({ status: 'failed', progress: 0, attempts: 1 });
        expect(failed?.error).toEqual(expect.any(String));
        expect(mockFiles.has(entry.uri)).toBe(true);
        expect(await stored()).toEqual([expect.objectContaining({ id: entry.id, status: 'failed', attempts: 1 })]);
    });

    it('treats a cancelled upload as queued again, not as a failure', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        upload.mockImplementationOnce(
            (_input, opts: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts.signal.addEventListener('abort', () => reject(new ApiError('Upload cancelled.')));
                }),
        );
        const running = useOutbox.getState().upload(entry.id);
        useOutbox.getState().cancel(entry.id);
        await running;
        expect(useOutbox.getState().items[0]).toMatchObject({ status: 'queued', error: null, attempts: 1 });
    });

    it('ignores a second upload of a row that is already uploading', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        let finish: (value: unknown) => void = () => {};
        upload.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
        const first = useOutbox.getState().upload(entry.id);
        await useOutbox.getState().upload(entry.id);
        expect(upload).toHaveBeenCalledTimes(1);
        finish({ id: 'n', status: 'processing', title: 'a' });
        await first;
    });

    it('discards the entry and deletes the audio', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        await useOutbox.getState().discard(entry.id);
        expect(useOutbox.getState().items).toEqual([]);
        expect(mockFiles.has(entry.uri)).toBe(false);
        expect(await stored()).toEqual([]);
    });

    it('edits the capture settings of one entry', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        useOutbox.getState().updateSettings(entry.id, { attendees: 'Tom, René' });
        expect(useOutbox.getState().items[0]?.settings).toMatchObject({ title: 'a', attendees: 'Tom, René' });
    });

    it('uploads everything one at a time, oldest first', async () => {
        const older = await useOutbox.getState().enqueue(recording('older'));
        const newer = await useOutbox.getState().enqueue(recording('newer'));
        useOutbox.setState({
            items: useOutbox
                .getState()
                .items.map((i) => (i.id === older.id ? { ...i, createdAt: '2026-01-01T00:00:00.000Z' } : i)),
        });
        const order: string[] = [];
        let inFlight = 0;
        upload.mockImplementation(async (input: { fileName: string }) => {
            inFlight += 1;
            expect(inFlight).toBe(1);
            order.push(input.fileName);
            await Promise.resolve();
            inFlight -= 1;
            return { id: input.fileName, status: 'processing', title: input.fileName };
        });
        await useOutbox.getState().uploadAll();
        expect(order).toEqual([older.fileName, newer.fileName]);
        expect(useOutbox.getState().items).toEqual([]);
    });

    it('restores the queue once, dropping rows whose file is gone and re-queueing interrupted uploads', async () => {
        mockFiles.add('file:///doc/recordings/kept.m4a');
        mockFiles.add('file:///doc/recordings/failed.m4a');
        const base = { fileName: 'x.m4a', mimeType: 'audio/mp4', sizeBytes: 1, durationSeconds: 1, createdAt: '2026-01-01T00:00:00.000Z', captureMode: 'recording', settings: {}, attempts: 0, error: null };
        await AsyncStorage.setItem(
            STORAGE_KEY,
            JSON.stringify([
                { ...base, id: 'kept', uri: 'file:///doc/recordings/kept.m4a', status: 'uploading' },
                { ...base, id: 'failed', uri: 'file:///doc/recordings/failed.m4a', status: 'failed', error: 'x' },
                { ...base, id: 'gone', uri: 'file:///doc/recordings/gone.m4a', status: 'queued' },
            ]),
        );
        await useOutbox.getState().hydrate();
        expect(useOutbox.getState().hydrated).toBe(true);
        expect(useOutbox.getState().items.map((i) => [i.id, i.status, i.progress])).toEqual([
            ['kept', 'queued', 0],
            ['failed', 'failed', 0],
        ]);

        // A second hydrate is a no-op: the queue in memory is the truth now.
        useOutbox.setState({ items: [] });
        await useOutbox.getState().hydrate();
        expect(useOutbox.getState().items).toEqual([]);
    });

    it('starts empty when the stored queue is unreadable', async () => {
        await AsyncStorage.setItem(STORAGE_KEY, '{not json');
        await useOutbox.getState().hydrate();
        expect(useOutbox.getState()).toMatchObject({ items: [], hydrated: true });
    });
});
