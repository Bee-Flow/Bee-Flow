/**
 * The session cache folder: created on use, wiped whole, and a wipe never
 * throws (a sign-out must not fail on a cache).
 */

import { clearSessionCache, sessionCacheDir } from './sessionCache';

const mockDirs = new Map<string, boolean>();
let mockDeleteThrows = false;

jest.mock('expo-file-system', () => {
    class Directory {
        uri: string;
        constructor(_parent: unknown, name: string) {
            this.uri = `file:///cache/${name}`;
        }
        get exists() {
            return mockDirs.get(this.uri) ?? false;
        }
        create() {
            mockDirs.set(this.uri, true);
        }
        delete() {
            if (mockDeleteThrows) throw new Error('busy');
            mockDirs.set(this.uri, false);
        }
    }
    return { Directory, Paths: { cache: 'cache' } };
});

beforeEach(() => {
    mockDirs.clear();
    mockDeleteThrows = false;
});

describe('sessionCache', () => {
    it('creates the folder on use and deletes it on clear', () => {
        expect(sessionCacheDir().uri).toBe('file:///cache/session');
        expect(mockDirs.get('file:///cache/session')).toBe(true);
        clearSessionCache();
        expect(mockDirs.get('file:///cache/session')).toBe(false);
    });

    it('never throws on clear', () => {
        sessionCacheDir();
        mockDeleteThrows = true;
        expect(() => clearSessionCache()).not.toThrow();
    });
});
