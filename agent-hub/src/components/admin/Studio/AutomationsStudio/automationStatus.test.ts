import { describe, expect, it } from 'vitest';
import { interpolate } from '../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { isSharedWithMe, roleLabel, roleOf, automationStatusParts } from './automationStatus';

const t: TranslateFn = (_key, fallback, params) =>
    interpolate(typeof fallback === 'string' ? fallback : '', params);

const words = (r: Parameters<typeof automationStatusParts>[0]) => automationStatusParts(r, t).map(p => p.text);

describe('automationStatusParts — the header words on a library row', () => {
    it('says "Draft · never live" while there is no live version', () => {
        expect(words({ neverLive: true, liveVersion: null, isActive: false })).toEqual(['Draft · never live']);
    });

    it('names the live version of an active automation', () => {
        expect(words({ neverLive: false, liveVersion: 3, isActive: true, pendingChanges: 0 })).toEqual(['Live · v3']);
    });

    it('says "Paused" for a switched-off automation that has been live', () => {
        expect(words({ neverLive: false, liveVersion: 2, isActive: false })).toEqual(['Paused']);
    });

    it('adds the changes that are not live yet as their own warning part', () => {
        const parts = automationStatusParts({ neverLive: false, liveVersion: 3, isActive: true, pendingChanges: 2 }, t);
        expect(parts.map(p => p.text)).toEqual(['Live · v3', '2 changes not live']);
        expect(parts[1].tone).toBe('pending');
        expect(words({ liveVersion: 3, isActive: true, pendingChanges: 1 })).toEqual(['Live · v3', '1 change not live']);
    });

    it('falls back on isDraft/isActive for a row from a server without the live split', () => {
        expect(words({ isDraft: true, isActive: false })).toEqual(['Draft · never live']);
        expect(words({ isDraft: false, isActive: true })).toEqual(['Live']);
        expect(words({ isDraft: false, isActive: false })).toEqual(['Paused']);
    });
});

describe('roles', () => {
    it('treats a row without myRole as the caller\'s own', () => {
        expect(roleOf({})).toBe('owner');
        expect(isSharedWithMe({ myRole: 'owner' })).toBe(false);
        expect(isSharedWithMe({ myRole: 'run' })).toBe(true);
        expect(roleOf({ myRole: 'nonsense' })).toBe('owner');
    });

    it('labels each shared role and none for the owner', () => {
        expect(roleLabel('run', t)).toBe('Can run');
        expect(roleLabel('view', t)).toBe('Can view');
        expect(roleLabel('edit', t)).toBe('Can edit');
        expect(roleLabel('owner', t)).toBeNull();
    });
});
