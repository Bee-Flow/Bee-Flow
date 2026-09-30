/**
 * The upload queue: one file at a time, a failure that keeps its row and can
 * be retried without re-picking, and a finished row that clears.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useUploadQueue } from './useUploadQueue';
import { uploadFile, type UploadFile, type UploadTarget } from '../api/upload';

jest.mock('../api/upload', () => ({ ...jest.requireActual('../api/upload'), uploadFile: jest.fn() }));

const upload = uploadFile as jest.Mock;
const TARGET: UploadTarget = { path: '/api/kb/kb1/ingest/file', field: 'file', maxBytes: 1024 };
const file = (name: string): UploadFile => ({ uri: `file:///${name}`, name, mimeType: 'text/plain', size: 10 });

/** A promise the test settles by hand. */
function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => upload.mockReset());

describe('useUploadQueue', () => {
    it('uploads one file at a time, in order, and reports each one', async () => {
        const first = deferred();
        const second = deferred();
        upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const onUploaded = jest.fn();
        const { result } = await renderHook(() => useUploadQueue(TARGET, { onUploaded }));

        await act(async () => result.current.add([file('a.txt'), file('b.txt')]));
        expect(upload).toHaveBeenCalledTimes(1);
        expect(result.current.items.map((i) => i.status)).toEqual(['uploading', 'queued']);
        expect(result.current.active).toBe(true);

        await act(async () => first.resolve({ ok: 1 }));
        expect(upload).toHaveBeenCalledTimes(2);
        expect(onUploaded).toHaveBeenCalledWith({ ok: 1 }, expect.objectContaining({ name: 'a.txt' }));

        await act(async () => second.resolve({ ok: 2 }));
        expect(result.current.items.map((i) => i.status)).toEqual(['done', 'done']);
        expect(result.current.active).toBe(false);
    });

    it('keeps a failed row with its reason, and retries it without re-picking', async () => {
        upload.mockRejectedValueOnce(new Error('The connection dropped')).mockResolvedValueOnce({});
        const { result } = await renderHook(() => useUploadQueue(TARGET));

        await act(async () => result.current.add([file('a.txt')]));
        const [failed] = result.current.items;
        expect(failed?.status).toBe('error');
        expect(failed?.error).toBeTruthy();

        await act(async () => result.current.retry(failed?.id ?? ''));
        expect(upload).toHaveBeenCalledTimes(2);
        expect(result.current.items[0]?.status).toBe('done');
    });

    it('clears finished rows and leaves failed ones', async () => {
        upload.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('no'));
        const { result } = await renderHook(() => useUploadQueue(TARGET));

        await act(async () => result.current.add([file('a.txt'), file('b.txt')]));
        await act(async () => result.current.clearFinished());
        expect(result.current.items.map((i) => i.name)).toEqual(['b.txt']);

        await act(async () => result.current.remove(result.current.items[0]?.id ?? ''));
        expect(result.current.items).toEqual([]);
    });
});
