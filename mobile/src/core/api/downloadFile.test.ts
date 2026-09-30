/**
 * downloadToCache: fetched on the app's session, streamed to disk, and never
 * leaves half a file behind.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { downloadToCache, safeFileName } from './downloadFile';
import { setServerUrl } from './server';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockFiles = new Map<string, { bytes: number[]; exists: boolean }>();

jest.mock('expo-file-system', () => {
    const uriOf = (dir: unknown) => (typeof dir === 'string' ? `file:///${dir}` : (dir as { uri: string }).uri);
    class Directory {
        uri: string;
        exists = true;
        constructor(parent: unknown, name: string) {
            this.uri = `${uriOf(parent)}/${name}`;
        }
        create() {}
    }
    class File {
        uri: string;
        constructor(dir: unknown, name: string) {
            this.uri = `${uriOf(dir)}/${name}`;
        }
        private get entry() {
            if (!mockFiles.has(this.uri)) mockFiles.set(this.uri, { bytes: [], exists: false });
            return mockFiles.get(this.uri)!;
        }
        get exists() {
            return this.entry.exists;
        }
        get size() {
            return this.entry.bytes.length;
        }
        create() {
            this.entry.exists = true;
            this.entry.bytes = [];
        }
        delete() {
            this.entry.exists = false;
            this.entry.bytes = [];
        }
        write(bytes: Uint8Array) {
            this.entry.bytes.push(...bytes);
        }
        open() {
            return { writeBytes: (b: Uint8Array) => this.write(b), close: jest.fn() };
        }
        moveSync(to: File) {
            mockFiles.set(to.uri, { ...this.entry });
            mockFiles.delete(this.uri);
            this.uri = to.uri;
        }
    }
    return { Directory, File, Paths: { cache: 'cache' } };
});

const fetchMock = expoFetch as unknown as jest.Mock;

function response(chunks: number[][], init: { ok?: boolean; status?: number; stream?: boolean } = {}) {
    let i = 0;
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        headers: { get: (name: string) => (name === 'content-type' ? 'audio/webm' : null) },
        json: async () => ({ error: 'Audio file not available' }),
        arrayBuffer: async () => new Uint8Array(chunks.flat()).buffer,
        body:
            init.stream === false
                ? null
                : {
                      getReader: () => ({
                          read: async () =>
                              i < chunks.length
                                  ? { done: false, value: new Uint8Array(chunks[i++] as number[]) }
                                  : { done: true },
                      }),
                  },
    };
}

beforeAll(async () => {
    await setServerUrl('https://bee.example');
});

beforeEach(() => {
    mockFiles.clear();
    fetchMock.mockReset();
});

describe('downloadToCache', () => {
    it('streams the body to disk with the session headers', async () => {
        fetchMock.mockResolvedValue(response([[1, 2], [3]]));
        const out = await downloadToCache('/api/transcriptions/m1/audio', 'meeting-audio-m1');
        expect(out).toEqual({ uri: 'file:///cache/meeting-audio-m1', contentType: 'audio/webm' });
        expect(mockFiles.get(out.uri)?.bytes).toEqual([1, 2, 3]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://bee.example/api/transcriptions/m1/audio');
        expect(init).toMatchObject({ credentials: 'include' });
        expect(init.headers['X-Beeflow-Client']).toBe('android');
    });

    it('falls back to one buffer when the runtime has no reader', async () => {
        fetchMock.mockResolvedValue(response([[7, 8]], { stream: false }));
        const out = await downloadToCache('/x', 'x');
        expect(mockFiles.get(out.uri)?.bytes).toEqual([7, 8]);
    });

    it('reuses a cached copy only when asked', async () => {
        fetchMock.mockResolvedValue(response([[1]]));
        await downloadToCache('/x', 'same');
        await downloadToCache('/x', 'same', { reuse: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await downloadToCache('/x', 'same');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws the server error and writes nothing', async () => {
        fetchMock.mockResolvedValue(response([], { ok: false, status: 404 }));
        await expect(downloadToCache('/x', 'gone')).rejects.toThrow('Audio file not available');
        expect(mockFiles.get('file:///cache/gone')?.exists ?? false).toBe(false);
    });

    it('deletes a half-written file when the stream breaks', async () => {
        const res = response([[1]]);
        res.body = { getReader: () => ({ read: async () => Promise.reject(new Error('reset')) }) };
        fetchMock.mockResolvedValue(res);
        await expect(downloadToCache('/x', 'broken')).rejects.toThrow('reset');
        expect(mockFiles.get('file:///cache/broken')?.exists ?? false).toBe(false);
        expect(mockFiles.get('file:///cache/broken.part')?.exists).toBe(false);
    });

    it('never reuses a download that was cut short', async () => {
        // The app was killed mid-stream: only the .part is on disk.
        mockFiles.set('file:///cache/cut.part', { bytes: [1], exists: true });
        fetchMock.mockResolvedValue(response([[1, 2, 3]]));
        const out = await downloadToCache('/x', 'cut', { reuse: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockFiles.get(out.uri)?.bytes).toEqual([1, 2, 3]);
    });

    it('keeps a session-scoped file in the session folder', async () => {
        fetchMock.mockResolvedValue(response([[4]]));
        const out = await downloadToCache('/x', 'meeting-audio-m1', { sessionScoped: true });
        expect(out.uri).toBe('file:///cache/session/meeting-audio-m1');
        expect(mockFiles.get(out.uri)?.bytes).toEqual([4]);
    });
});

describe('safeFileName', () => {
    it('keeps what Android accepts and falls back when nothing is left', () => {
        expect(safeFileName('a/b:c.mp3')).toBe('a_b_c.mp3');
        expect(safeFileName('   ', 'document')).toBe('document');
    });
});
