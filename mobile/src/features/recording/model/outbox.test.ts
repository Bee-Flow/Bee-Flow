/**
 * The outbox holds the only copy of a meeting until the server says 202, so
 * each promise its header makes is pinned: an entry leaves only on an
 * acknowledged upload, a failure keeps the entry and the file with a reason, a
 * cancel is not a failure, the queue survives a restart (minus rows whose
 * file is gone), and "upload all" goes one at a time, oldest first.
 *
 * The file moves that feed it (files.ts) are pinned at the bottom: two
 * recordings stopped in the same clock minute get the same readable name, and
 * moving the second one over the first destroyed a meeting that existed only
 * on this phone, so each move must land on a file of its own and nothing is
 * ever moved over an existing one.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError } from '@/core/api/client';

import { deleteQuietly, moveIntoLibrary, moveIntoOutbox } from './files';
import { useOutbox, type NewPendingRecording } from './outbox';
import { uploadRecording } from '../api/upload';

jest.mock('../api/upload', () => ({ uploadRecording: jest.fn() }));

const mockDisk = new Map<string, string>();

jest.mock('expo-file-system', () => {
    class Directory {
        uri: string;
        constructor(parent: { uri: string }, name: string) {
            this.uri = `${parent.uri}/${name}`;
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
            return mockDisk.has(this.uri);
        }
        get size() {
            return mockDisk.get(this.uri)?.length ?? 0;
        }
        // As expo-file-system: an existing destination is replaced only with
        // `overwrite: true`, and is an error otherwise.
        moveSync(destination: { uri: string }, options?: { overwrite?: boolean }) {
            if (mockDisk.has(destination.uri) && !options?.overwrite) throw new Error('DestinationAlreadyExists');
            mockDisk.set(destination.uri, mockDisk.get(this.uri) ?? '');
            mockDisk.delete(this.uri);
            this.uri = destination.uri;
        }
        delete() {
            mockDisk.delete(this.uri);
        }
    }
    return { Directory, File, Paths: { document: { uri: 'file:///doc' } } };
});

const upload = uploadRecording as jest.Mock;
const STORAGE_KEY = 'beeflow.recordings.outbox.v1';

function recording(name: string): NewPendingRecording {
    const uri = `file:///doc/recordings/${name}.m4a`;
    mockDisk.set(uri, '');
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
    mockDisk.clear();
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
            expect(mockDisk.has(entry.uri)).toBe(true);
            return { id: 'note-1', status: 'processing', title: 'a' };
        });
        const onAccepted = jest.fn();
        await useOutbox.getState().upload(entry.id, onAccepted);
        expect(upload).toHaveBeenCalledWith(
            expect.objectContaining({ uri: entry.uri, captureMode: 'recording', settings: entry.settings, clientUploadId: entry.id }),
            expect.anything(),
        );
        expect(onAccepted).toHaveBeenCalledWith({ id: 'note-1', status: 'processing', title: 'a' });
        expect(useOutbox.getState().items).toEqual([]);
        expect(mockDisk.has(entry.uri)).toBe(false);
        expect(await stored()).toEqual([]);
    });

    it('keeps a failed upload, its file and a reason, and counts the attempt', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        upload.mockRejectedValueOnce(new ApiError('The connection dropped', { status: 0 }));
        await useOutbox.getState().upload(entry.id);
        const [failed] = useOutbox.getState().items;
        expect(failed).toMatchObject({ status: 'failed', progress: 0, attempts: 1 });
        expect(failed?.error).toEqual(expect.any(String));
        expect(mockDisk.has(entry.uri)).toBe(true);
        expect(await stored()).toEqual([expect.objectContaining({ id: entry.id, status: 'failed', attempts: 1 })]);
    });

    it('a retry after a lost answer sends the same upload id, so the server answers with the first note', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        upload.mockRejectedValueOnce(new ApiError('The connection dropped', { status: 0 }));
        await useOutbox.getState().upload(entry.id);
        upload.mockResolvedValueOnce({ id: 'note-1', status: 'processing', title: 'a', dedup: true });
        await useOutbox.getState().upload(entry.id);
        const ids = upload.mock.calls.map(([input]) => (input as { clientUploadId?: string }).clientUploadId);
        expect(ids).toEqual([entry.id, entry.id]);
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
        expect(mockDisk.has(entry.uri)).toBe(false);
        expect(await stored()).toEqual([]);
    });

    it('edits the capture settings of one entry', async () => {
        const entry = await useOutbox.getState().enqueue(recording('a'));
        useOutbox.getState().updateSettings(entry.id, { attendees: 'Tom, René' });
        expect(useOutbox.getState().items[0]?.settings).toMatchObject({ title: 'a', attendees: 'Tom, René' });
    });

    it('refuses a second entry for a file another entry already holds', async () => {
        const input = recording('a');
        const first = await useOutbox.getState().enqueue(input);
        const second = await useOutbox.getState().enqueue({ ...input, settings: { ...input.settings, title: 'b' } });
        expect(second.id).toBe(first.id);
        expect(useOutbox.getState().items).toHaveLength(1);
    });

    it('drains, one at a time and oldest first, the entries the person asked to upload', async () => {
        const older = await useOutbox.getState().enqueue(recording('older'));
        const newer = await useOutbox.getState().enqueue(recording('newer'));
        useOutbox.setState({
            items: useOutbox.getState().items.map((i) => ({
                ...i,
                autoUpload: true,
                ...(i.id === older.id ? { createdAt: '2026-01-01T00:00:00.000Z' } : {}),
            })),
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

    it('never drains a draft, a kept recording, a cancelled upload or a refusal for good', async () => {
        // Fresh from Stop: its details sheet may still be open, or the person
        // chose "Keep on this phone for now". Either way it was never asked for.
        const draft = await useOutbox.getState().enqueue(recording('draft'));

        const cancelled = await useOutbox.getState().enqueue(recording('cancelled'));
        upload.mockImplementationOnce(
            (_input, opts: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    opts.signal.addEventListener('abort', () => reject(new ApiError('Upload cancelled.')));
                }),
        );
        const running = useOutbox.getState().upload(cancelled.id);
        useOutbox.getState().cancel(cancelled.id);
        await running;

        const refused = await useOutbox.getState().enqueue(recording('refused'));
        upload.mockRejectedValueOnce(new ApiError('Plan limit reached', { status: 402 }));
        await useOutbox.getState().upload(refused.id);

        const offline = await useOutbox.getState().enqueue(recording('offline'));
        upload.mockRejectedValueOnce(new ApiError('The connection dropped', { status: 0 }));
        await useOutbox.getState().upload(offline.id);

        upload.mockReset();
        upload.mockImplementation(async (input: { fileName: string }) => ({ id: input.fileName, status: 'processing', title: input.fileName }));
        await useOutbox.getState().uploadAll();

        // Only the one the person asked for that failed on the network.
        expect(upload.mock.calls.map(([input]) => (input as { fileName: string }).fileName)).toEqual(['offline.m4a']);
        expect(useOutbox.getState().items.map((i) => i.id).sort()).toEqual([draft.id, cancelled.id, refused.id].sort());

        // An explicit retry is always possible, and puts it back in the drain.
        upload.mockRejectedValueOnce(new ApiError('The connection dropped', { status: 0 }));
        await useOutbox.getState().upload(refused.id);
        expect(useOutbox.getState().items.find((i) => i.id === refused.id)).toMatchObject({ status: 'failed', autoUpload: true });
    });

    it('keeps the upload request across an app killed mid-upload, so the next drain still retries it', async () => {
        const entry = await useOutbox.getState().enqueue(recording('killed'));
        // The upload never answers: the app is killed while it runs.
        upload.mockImplementationOnce(() => new Promise(() => undefined));
        void useOutbox.getState().upload(entry.id);
        await new Promise((resolve) => setImmediate(resolve));
        const [saved] = (await stored()) as Record<string, unknown>[];
        expect(saved).toMatchObject({ id: entry.id, status: 'queued', autoUpload: true });

        // A fresh start reads the persisted copy and drains it.
        useOutbox.setState({ items: [], hydrated: false });
        await useOutbox.getState().hydrate();
        upload.mockResolvedValueOnce({ id: 'm1', status: 'processing', title: 'killed' });
        await useOutbox.getState().uploadAll();
        expect(upload).toHaveBeenCalledTimes(2);
        expect(useOutbox.getState().items).toEqual([]);
    });

    it('restores the queue once, dropping rows whose file is gone and re-queueing interrupted uploads', async () => {
        mockDisk.set('file:///doc/recordings/kept.m4a', '');
        mockDisk.set('file:///doc/recordings/failed.m4a', '');
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

describe('moveIntoLibrary', () => {
    it('keeps both of two recordings stopped in the same minute', () => {
        mockDisk.set('file:///cache/one.aac', 'ONE-HOUR-MEETING');
        mockDisk.set('file:///cache/two.aac', 'ADDENDUM');
        const first = moveIntoLibrary('file:///cache/one.aac', 3600, new Date(2026, 10, 4, 10, 0, 5));
        const second = moveIntoLibrary('file:///cache/two.aac', 30, new Date(2026, 10, 4, 10, 0, 50));

        expect(first).toMatchObject({
            uri: 'file:///doc/recordings/Meeting 2026-11-04 10-00.aac',
            fileName: 'Meeting 2026-11-04 10-00.aac',
        });
        expect(second).toMatchObject({
            uri: 'file:///doc/recordings/Meeting 2026-11-04 10-00 (2).aac',
            fileName: 'Meeting 2026-11-04 10-00 (2).aac',
        });
        expect(mockDisk.get(first.uri)).toBe('ONE-HOUR-MEETING');
        expect(mockDisk.get(second.uri)).toBe('ADDENDUM');

        // The first upload's cleanup leaves the second recording alone.
        deleteQuietly(first.uri);
        expect(mockDisk.get(second.uri)).toBe('ADDENDUM');
    });

    it('counts on past the names already taken', () => {
        mockDisk.set('file:///doc/recordings/Meeting 2026-11-04 10-00.aac', 'A');
        mockDisk.set('file:///doc/recordings/Meeting 2026-11-04 10-00 (2).aac', 'B');
        mockDisk.set('file:///cache/three.aac', 'C');
        const third = moveIntoLibrary('file:///cache/three.aac', 10, new Date(2026, 10, 4, 10, 0, 59));
        expect(third.fileName).toBe('Meeting 2026-11-04 10-00 (3).aac');
        expect([...mockDisk.values()].sort()).toEqual(['A', 'B', 'C']);
    });
});

describe('moveIntoOutbox', () => {
    it('never replaces a queued import of the same name', () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        try {
            mockDisk.set('file:///cache/a/memo.mp3', 'FIRST');
            mockDisk.set('file:///cache/b/memo.mp3', 'SECOND');
            const first = moveIntoOutbox('file:///cache/a/memo.mp3', 'memo.mp3');
            const second = moveIntoOutbox('file:///cache/b/memo.mp3', 'memo.mp3');
            expect(first.uri).not.toBe(second.uri);
            expect(mockDisk.get(first.uri)).toBe('FIRST');
            expect(mockDisk.get(second.uri)).toBe('SECOND');
        } finally {
            now.mockRestore();
        }
    });
});
