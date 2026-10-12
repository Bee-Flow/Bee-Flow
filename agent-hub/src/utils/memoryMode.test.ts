import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    memoryFlagsFor, memoryLockOf, nextMemoryMode, readStoredMemoryFlags, readStoredMemoryMode, storeMemoryMode,
} from './memoryMode';
import scopedStorage from './scopedStorage';

beforeEach(() => { localStorage.clear(); scopedStorage.setCurrentUser('u1'); });
afterEach(() => { scopedStorage.setCurrentUser(null); });

describe('memory mode', () => {
    it('starts On, and cycles On, Read only, Off', () => {
        expect(readStoredMemoryMode()).toBe('on');
        expect(nextMemoryMode('on')).toBe('read');
        expect(nextMemoryMode('read')).toBe('off');
        expect(nextMemoryMode('off')).toBe('on');
    });

    it('maps each mode to the two request flags', () => {
        expect(memoryFlagsFor('on')).toEqual({ memoryReadEnabled: true, memoryWriteEnabled: true });
        expect(memoryFlagsFor('read')).toEqual({ memoryReadEnabled: true, memoryWriteEnabled: false });
        expect(memoryFlagsFor('off')).toEqual({ memoryReadEnabled: false, memoryWriteEnabled: false });
    });

    it('reads the old boolean: false was Read only, true was On', () => {
        scopedStorage.setItem('memoryWriteEnabled', 'false');
        expect(readStoredMemoryMode()).toBe('read');
        scopedStorage.setItem('memoryWriteEnabled', 'true');
        expect(readStoredMemoryMode()).toBe('on');
    });

    it('a stored mode wins over the old boolean, and an unknown value is ignored', () => {
        scopedStorage.setItem('memoryWriteEnabled', 'false');
        storeMemoryMode('off');
        expect(readStoredMemoryFlags()).toEqual({ memoryReadEnabled: false, memoryWriteEnabled: false });
        scopedStorage.setItem('memoryMode', 'nonsense');
        expect(readStoredMemoryMode()).toBe('read');
    });

    it('says why memory is locked: the organisation first, then the person', () => {
        expect(memoryLockOf(null)).toBeNull();
        expect(memoryLockOf({ memoryEnabled: true, orgMemoryEnabled: true })).toBeNull();
        expect(memoryLockOf({ memoryEnabled: false })).toBe('user_paused');
        expect(memoryLockOf({ orgMemoryEnabled: false })).toBe('org_off');
        expect(memoryLockOf({ memoryEnabled: false, orgMemoryEnabled: false })).toBe('org_off');
    });
});
