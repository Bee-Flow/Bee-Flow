// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '@/hooks/useTranslation';
import { NC_SYNC_MODES, isNcSyncMode, relativeSince, syncModeDescription, syncModeLabel } from './ncSyncText';

const t = ((_key: string | undefined, fallback?: unknown) => (typeof fallback === 'string' ? fallback : '')) as TranslateFn;

describe('relativeSince', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');

    it('says how long ago in the viewer language', () => {
        expect(relativeSince('2026-11-15T11:55:00Z', 'en', now)).toBe('5 minutes ago');
        expect(relativeSince('2026-11-15T09:00:00Z', 'en', now)).toBe('3 hours ago');
        expect(relativeSince('2026-11-13T12:00:00Z', 'en', now)).toBe('2 days ago');
        expect(relativeSince('2026-11-15T11:55:00Z', 'nl', now)).toBe('5 minuten geleden');
    });

    it('reads under a minute as now, and a week or more as the date', () => {
        expect(relativeSince('2026-11-15T11:59:30Z', 'en', now)).toBe('now');
        expect(relativeSince('2026-11-01T12:00:00Z', 'en', now)).toBe(new Date('2026-11-01T12:00:00Z').toLocaleDateString('en'));
    });

    it('is null for nothing or something unreadable', () => {
        expect(relativeSince(undefined, 'en', now)).toBeNull();
        expect(relativeSince('', 'en', now)).toBeNull();
        expect(relativeSince('not a date', 'en', now)).toBeNull();
    });
});

describe('sync modes', () => {
    it('names and describes each mode', () => {
        for (const mode of NC_SYNC_MODES) {
            expect(syncModeLabel(t, mode)).not.toBe('');
            expect(syncModeDescription(t, mode)).not.toBe('');
        }
        expect(isNcSyncMode('selective_groups')).toBe(true);
        expect(isNcSyncMode('everything')).toBe(false);
    });
});
