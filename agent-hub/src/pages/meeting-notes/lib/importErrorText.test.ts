import { describe, expect, it } from 'vitest';
import { importErrorText } from './importErrorText';
import type { TranslateFn } from '@/hooks/useTranslation';

const t = ((_key: string, fallback?: string) => fallback ?? _key) as TranslateFn;

describe('importErrorText', () => {
    it('says that a colleague already imported the meeting, instead of a generic failure', () => {
        expect(importErrorText(t, 'already_imported')).toMatch(/already imported this meeting/);
    });

    it('names a transcription engine the workspace does not allow', () => {
        expect(importErrorText(t, 'provider_not_allowed')).toMatch(/not enabled for this workspace/);
    });

    it('keeps the shared sentences per code group', () => {
        expect(importErrorText(t, 'needs_meet_scopes')).toBe(importErrorText(t, 'needs_teams_scopes'));
        expect(importErrorText(t, 'no_conference')).toBe(importErrorText(t, 'no_recording'));
    });

    it('falls back to the generic failure for an unknown, empty or prototype code', () => {
        const failed = 'The import failed. Try again in a moment.';
        expect(importErrorText(t, 'something_new')).toBe(failed);
        expect(importErrorText(t, null)).toBe(failed);
        expect(importErrorText(t, 'toString')).toBe(failed);
    });
});
