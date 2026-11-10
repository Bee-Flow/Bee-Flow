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

    it('names the Teams failure codes by their own cause', () => {
        expect(importErrorText(t, 'graph_forbidden')).toMatch(/refused access to this meeting/);
        expect(importErrorText(t, 'meeting_not_available')).toMatch(/no online meeting for this calendar entry/);
        expect(importErrorText(t, 'application_access_policy_missing')).toMatch(/application access policy/);
        expect(importErrorText(t, 'calendar_forbidden')).toMatch(/refused access to your calendar/);
        expect(importErrorText(t, 'graph_throttled')).toMatch(/limiting requests/);
        expect(importErrorText(t, 'graph_unavailable')).toMatch(/did not answer properly/);
        expect(importErrorText(t, 'download_failed')).toMatch(/could not be downloaded/);
        expect(importErrorText(t, 'too_many_imports')).toMatch(/Too many imports/);
    });

    it('tells the switched-off transcript API apart from switched-off speaker names; Drive access is unchanged', () => {
        const transcript = importErrorText(t, 'transcript_access_disabled');
        const speakers = importErrorText(t, 'speaker_attribution_disabled');
        expect(transcript).toMatch(/API access to meeting transcripts/);
        expect(speakers).toMatch(/speaker names/);
        expect(transcript).not.toBe(speakers);
        expect(importErrorText(t, 'no_drive_access')).toBe('Your organisation does not allow access to this recording.');
    });

    it('falls back to the generic failure for an unknown, empty or prototype code', () => {
        const failed = 'The import failed. Try again in a moment.';
        expect(importErrorText(t, 'something_new')).toBe(failed);
        expect(importErrorText(t, null)).toBe(failed);
        expect(importErrorText(t, 'toString')).toBe(failed);
    });
});
