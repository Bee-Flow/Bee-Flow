/**
 * A refused re-transcribe says what the code means to the person holding the
 * phone; anything without a known code falls back to describeError's words.
 */

import { ApiError } from '@/core/api/client';

import { reprocessErrorCode, reprocessFailureMessage } from './reprocess';

describe('reprocessErrorCode', () => {
    it('reads the code off the body of an ApiError', () => {
        const error = new ApiError('Gone', { status: 410, body: { code: 'audio_gone_recorded' } });
        expect(reprocessErrorCode(error)).toBe('audio_gone_recorded');
    });

    it('answers null for anything else', () => {
        expect(reprocessErrorCode(new ApiError('x', { status: 500, body: 'oops' }))).toBeNull();
        expect(reprocessErrorCode(new ApiError('x', { status: 500, body: { code: 7 } }))).toBeNull();
        expect(reprocessErrorCode(new Error('plain'))).toBeNull();
    });
});

describe('reprocessFailureMessage', () => {
    it('words each refusal code', () => {
        expect(reprocessFailureMessage('already_processing', 'fallback')).toMatch(/already being transcribed/);
        expect(reprocessFailureMessage('audio_gone_recorded', 'fallback')).toMatch(/never another copy/);
        expect(reprocessFailureMessage('audio_gone_uploaded', 'fallback')).toMatch(/Import the original file/);
        expect(reprocessFailureMessage('audio_storage_unavailable', 'fallback')).toMatch(/briefly unavailable/);
    });

    it('falls back for no code and for a code it does not know', () => {
        expect(reprocessFailureMessage(null, 'The server said no.')).toBe('The server said no.');
        expect(reprocessFailureMessage('toString', 'The server said no.')).toBe('The server said no.');
    });
});
