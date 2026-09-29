import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    setCurrentUser,
    getCurrentUser,
    getItem,
    setItem,
    removeItem,
    getJSON,
    setJSON,
    clearUser,
} from './scopedStorage';

describe('scopedStorage', () => {
    beforeEach(() => {
        localStorage.clear();
        setCurrentUser(null);
    });
    afterEach(() => {
        localStorage.clear();
        setCurrentUser(null);
    });

    it('returns null and writes are no-ops when no user is active', () => {
        setItem('foo', 'bar');
        expect(getItem('foo')).toBeNull();
        expect(getCurrentUser()).toBeNull();
    });

    it('namespaces keys under the active user id', () => {
        setCurrentUser('user-1');
        setItem('foo', 'bar');
        expect(localStorage.getItem('beeflow:user-1:foo')).toBe('bar');
        expect(getItem('foo')).toBe('bar');
    });

    it('isolates one user from another (no cross-account leak)', () => {
        setCurrentUser('user-1');
        setItem('lastAgent', 'agent-A');
        setCurrentUser('user-2');
        expect(getItem('lastAgent')).toBeNull();
        setItem('lastAgent', 'agent-B');
        setCurrentUser('user-1');
        expect(getItem('lastAgent')).toBe('agent-A');
    });

    it('ignores legacy unscoped keys — the one-time pass in storageMigrations owns those', () => {
        localStorage.setItem('legacyOnly', 'hi');
        setCurrentUser('user-1');
        // No lazy copy: the old behaviour let whichever account read first
        // claim the bare value AND left the original for the next account.
        expect(getItem('legacyOnly')).toBeNull();
        expect(localStorage.getItem('beeflow:user-1:legacyOnly')).toBeNull();
        expect(localStorage.getItem('legacyOnly')).toBe('hi');
    });

    it('round-trips JSON via getJSON / setJSON with a fallback on missing', () => {
        setCurrentUser('user-1');
        setJSON('flags', { dark: true });
        expect(getJSON('flags')).toEqual({ dark: true });
        expect(getJSON('missing', { fallback: 1 })).toEqual({ fallback: 1 });
    });

    it('removes only scoped keys for the given user on clearUser', () => {
        setCurrentUser('user-1');
        setItem('a', '1');
        setCurrentUser('user-2');
        setItem('a', '2');
        clearUser('user-1');
        setCurrentUser('user-1');
        expect(getItem('a')).toBeNull();
        setCurrentUser('user-2');
        expect(getItem('a')).toBe('2');
    });

    it('removeItem only affects the active user', () => {
        setCurrentUser('user-1');
        setItem('k', 'v');
        removeItem('k');
        expect(getItem('k')).toBeNull();
    });
});
