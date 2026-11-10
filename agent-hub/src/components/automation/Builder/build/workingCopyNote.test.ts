import { describe, expect, it } from 'vitest';
import { editsBesideLiveVersion } from './workingCopyNote';

describe('editsBesideLiveVersion: when the assistant says its changes go to the working copy', () => {
    it('is true only for an automation that is switched on with a live version', () => {
        expect(editsBesideLiveVersion({ isActive: true, neverLive: false, liveVersion: 3, version: 5 })).toBe(true);
    });

    it.each([
        ['a draft that never went live', { isActive: false, neverLive: true, liveVersion: null, version: 1 }],
        ['a paused automation', { isActive: false, neverLive: false, liveVersion: 3, version: 5 }],
        ['an automation that is not saved yet', null],
    ])('is false for %s', (_what, row) => {
        expect(editsBesideLiveVersion(row)).toBe(false);
    });
});
