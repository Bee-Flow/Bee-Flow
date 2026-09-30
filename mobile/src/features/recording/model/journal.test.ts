/**
 * The journal is the only thing on the phone that remembers a recording the
 * app died in the middle of. Pinned: it round-trips, it follows the file when
 * Stop moves it, a recording that outlived its app is moved into the library
 * and named after when it started, and nothing is ever deleted — a live
 * recording, one the outbox already holds, and a missing or empty file all
 * leave the files alone.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { extensionOf, mimeTypeFor } from './files';
import {
    closeJournal,
    estimateSeconds,
    moveJournal,
    openJournal,
    readJournal,
    recoverInterrupted,
    type JournalEntry,
} from './journal';

/** Files as uri → size, and a log of what moved or was deleted. */
const mockFs = { files: new Map<string, number>(), moves: [] as [string, string][], deleted: [] as string[] };
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
            return mockFs.files.has(this.uri);
        }
        get size() {
            return mockFs.files.get(this.uri) ?? 0;
        }
        moveSync(destination: { uri: string }) {
            mockFs.moves.push([this.uri, destination.uri]);
            mockFs.files.set(destination.uri, this.size);
            mockFs.files.delete(this.uri);
        }
        delete() {
            mockFs.deleted.push(this.uri);
            mockFs.files.delete(this.uri);
        }
    }
    return { Directory, File, Paths: { document: { uri: 'file:///doc' } } };
});

const RAW = 'file:///doc/Audio/recording-1.aac';
const ENTRY: JournalEntry = {
    uri: RAW,
    startedAt: new Date(2026, 8, 27, 14, 5).toISOString(),
    settings: { extension: '.aac', bitRate: 64000 },
};
const nobody = { isLive: () => false, isQueued: () => false };

beforeEach(async () => {
    await AsyncStorage.clear();
    mockFs.files = new Map();
    mockFs.moves = [];
    mockFs.deleted = [];
});

describe('the journal', () => {
    it('round-trips an entry and forgets it on close', async () => {
        await openJournal(ENTRY);
        expect(await readJournal()).toEqual(ENTRY);
        await closeJournal();
        expect(await readJournal()).toBeNull();
    });

    it('follows the file when Stop moves it', async () => {
        await openJournal(ENTRY);
        await moveJournal('file:///doc/recordings/Meeting.aac');
        expect(await readJournal()).toEqual({ ...ENTRY, uri: 'file:///doc/recordings/Meeting.aac' });
    });

    it('reads a damaged entry as no entry', async () => {
        await AsyncStorage.setItem('beeflow.recordings.journal.v1', '{"uri":');
        expect(await readJournal()).toBeNull();
        await AsyncStorage.setItem('beeflow.recordings.journal.v1', '{"uri":"x"}');
        expect(await readJournal()).toBeNull();
    });
});

describe('estimateSeconds', () => {
    it('reads a constant bit rate back into a length', () => {
        // 64 kbit/s is 8 000 bytes a second.
        expect(estimateSeconds(8000 * 90, 64000)).toBe(90);
        expect(estimateSeconds(0, 64000)).toBe(0);
        expect(estimateSeconds(1000, 0)).toBe(0);
    });
});

describe('recoverInterrupted', () => {
    it('finds nothing when nothing was recording', async () => {
        expect(await recoverInterrupted(nobody)).toBeNull();
    });

    it('moves an orphaned recording into the library, named after when it started', async () => {
        mockFs.files.set(RAW, 8000 * 600);
        await openJournal(ENTRY);
        const found = await recoverInterrupted(nobody);
        expect(found).toEqual({
            startedAt: ENTRY.startedAt,
            audio: {
                uri: 'file:///doc/recordings/Meeting 2026-09-27 14-05.aac',
                fileName: 'Meeting 2026-09-27 14-05.aac',
                mimeType: 'audio/aac',
                sizeBytes: 8000 * 600,
                durationSeconds: 600,
            },
        });
        // The journal follows it until the outbox has it; the caller closes it.
        expect((await readJournal())?.uri).toBe(found?.audio.uri);
        expect(mockFs.deleted).toEqual([]);
    });

    it('leaves a live recording alone, journal and all', async () => {
        mockFs.files.set(RAW, 5000);
        await openJournal(ENTRY);
        expect(await recoverInterrupted({ ...nobody, isLive: (uri) => uri === RAW })).toBeNull();
        expect(mockFs.moves).toEqual([]);
        expect(await readJournal()).toEqual(ENTRY);
    });

    it('does not queue a file the outbox already holds', async () => {
        mockFs.files.set(RAW, 5000);
        await openJournal(ENTRY);
        expect(await recoverInterrupted({ ...nobody, isQueued: (uri) => uri === RAW })).toBeNull();
        expect(mockFs.moves).toEqual([]);
        expect(mockFs.deleted).toEqual([]);
        expect(await readJournal()).toBeNull();
    });

    it('lets go of an entry whose file is missing or empty, and deletes nothing', async () => {
        await openJournal(ENTRY);
        expect(await recoverInterrupted(nobody)).toBeNull();
        expect(await readJournal()).toBeNull();

        mockFs.files.set(RAW, 0);
        await openJournal(ENTRY);
        expect(await recoverInterrupted(nobody)).toBeNull();
        expect(mockFs.files.has(RAW)).toBe(true);
        expect(mockFs.deleted).toEqual([]);
    });
});

describe('the file type follows the container', () => {
    it('declares ADTS as audio/aac and MPEG-4 as audio/mp4', () => {
        expect(extensionOf('file:///doc/Audio/recording-1.AAC')).toBe('.aac');
        expect(mimeTypeFor('file:///doc/Audio/recording-1.aac')).toBe('audio/aac');
        expect(mimeTypeFor('file:///cache/raw.m4a')).toBe('audio/mp4');
        expect(mimeTypeFor('file:///cache/raw')).toBe('audio/mp4');
    });
});
