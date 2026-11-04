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
    });
});
