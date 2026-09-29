import { describe, it, expect } from 'vitest';
import { liveStateOf } from './liveState';

describe('liveStateOf: where the working copy stands against the live version', () => {
    it('never live: Activate, no pending changes counted', () => {
        expect(liveStateOf({ isActive: false, version: 2, liveVersion: null, neverLive: true, pendingChanges: 0 }))
            .toMatchObject({ kind: 'never', primary: 'activate', canPause: false, pendingChanges: 0, workingVersion: 2 });
    });

    it('live and up to date: no primary, Pause alone', () => {
        expect(liveStateOf({ isActive: true, version: 3, liveVersion: 3, neverLive: false, pendingChanges: 0 }))
            .toMatchObject({ kind: 'live', primary: null, canPause: true, liveVersion: 3 });
    });

    it('live with saved changes: Make vN live, Pause as the secondary', () => {
        expect(liveStateOf({ isActive: true, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 }))
            .toMatchObject({ kind: 'live', primary: 'publish', canPause: true, workingVersion: 5, pendingChanges: 2 });
    });

    it('paused: Activate, pending changes still reported', () => {
        expect(liveStateOf({ isActive: false, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 1 }))
            .toMatchObject({ kind: 'paused', primary: 'activate', canPause: false, pendingChanges: 1 });
    });

    it('takes the counts figure when the row carries none (a PUT answer)', () => {
        expect(liveStateOf({ isActive: true, version: 5, liveVersion: 3 }, 4))
            .toMatchObject({ primary: 'publish', pendingChanges: 4 });
    });

    it('an older server without live columns falls back to isDraft', () => {
        expect(liveStateOf({ isDraft: true, isActive: false }).kind).toBe('never');
        expect(liveStateOf({ isDraft: false, isActive: true }).kind).toBe('live');
        expect(liveStateOf({ isDraft: false, isActive: false }).kind).toBe('paused');
        expect(liveStateOf(null).kind).toBe('paused');
    });
});
