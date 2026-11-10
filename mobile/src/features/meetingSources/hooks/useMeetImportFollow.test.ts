/**
 * Reading a followed Meet import's job row: when it is still running, when it
 * waits for Google, when it made the note and when it failed (with its reason).
 */

import type { TranslateFn } from '@/core/i18n';

import { importErrorText, meetImportPhase } from './useMeetImportFollow';
import type { MeetImportJob } from '../model/types';

const job = (patch: Partial<MeetImportJob>): MeetImportJob => ({
    id: 'j1',
    title: null,
    meetingStart: null,
    status: 'pending',
    errorCode: null,
    transcriptionId: null,
    ...patch,
});

const t: TranslateFn = (_key, fallback) => fallback;

describe('meetImportPhase', () => {
    it('is running until the row is read and while it is pending, retries included', () => {
        expect(meetImportPhase(undefined)).toBe('running');
        expect(meetImportPhase(job({}))).toBe('running');
        expect(meetImportPhase(job({ errorCode: 'download_failed' }))).toBe('running');
    });

    it('waits for Google, is done with a note and failed otherwise', () => {
        expect(meetImportPhase(job({ status: 'awaiting_artifacts' }))).toBe('waiting');
        expect(meetImportPhase(job({ status: 'ingested', transcriptionId: 'n1' }))).toBe('done');
        expect(meetImportPhase(job({ status: 'no_drive_access', errorCode: 'no_drive_access' }))).toBe('failed');
        expect(meetImportPhase(null)).toBe('failed');
    });
});

describe('importErrorText', () => {
    it('names the reason a code stands for, and a generic sentence for the rest', () => {
        expect(importErrorText(t, 'no_drive_access')).toBe('Your organisation does not allow access to this recording.');
        expect(importErrorText(t, 'recording_too_large')).toBe('The recording is too large to import.');
        expect(importErrorText(t, 'something_new')).toBe('The import failed. Try again in a moment.');
        expect(importErrorText(t, 'toString')).toBe('The import failed. Try again in a moment.');
        expect(importErrorText(t, null)).toBe('The import failed. Try again in a moment.');
    });

    it('names the Teams failure codes by their own cause, with the web keys', () => {
        const keys: string[] = [];
        const record: TranslateFn = (key, fallback) => { keys.push(key); return fallback; };
        const codes: Record<string, string> = {
            graph_forbidden: 'meetings.import_error_graph_forbidden',
            meeting_not_available: 'meetings.import_error_meeting_not_available',
            application_access_policy_missing: 'meetings.import_error_access_policy',
            calendar_forbidden: 'meetings.import_error_calendar_forbidden',
            graph_throttled: 'meetings.import_error_throttled',
            graph_unavailable: 'meetings.import_error_graph_unavailable',
            download_failed: 'meetings.import_error_download_failed',
            too_many_imports: 'meetings.import_error_too_many',
            transcript_access_disabled: 'meetings.import_error_transcript_api_off',
            speaker_attribution_disabled: 'meetings.import_error_speaker_attribution_off',
            no_drive_access: 'meetings.import_error_access_disabled',
            already_imported: 'meetings.import_error_already_imported',
            provider_not_allowed: 'meetings.import_error_provider_not_allowed',
        };
        for (const [code, key] of Object.entries(codes)) {
            keys.length = 0;
            importErrorText(record, code);
            expect(keys).toEqual([key]);
        }
    });

    it('tells the switched-off transcript API apart from switched-off speaker names', () => {
        expect(importErrorText(t, 'transcript_access_disabled')).toMatch(/API access to meeting transcripts/);
        expect(importErrorText(t, 'speaker_attribution_disabled')).toMatch(/speaker names/);
    });
});
