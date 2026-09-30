/**
 * Why a re-transcribe was refused, in words for the person holding the phone.
 *
 * POST /:id/reprocess answers with a code the UI must branch on rather than
 * showing the prose (see reprocessTranscription in api/endpoints.ts), because
 * each code means something different and only one is worth trying again.
 */

import { ApiError } from '@/core/api/client';

/** The `code` on a reprocess failure, when the server sent one. */
export function reprocessErrorCode(error: unknown): string | null {
    if (!(error instanceof ApiError)) return null;
    const body = error.body;
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
        return (body as { code: string }).code;
    }
    return null;
}

const MESSAGES = new Map<string, string>([
    ['already_processing', 'It is already being transcribed. Give it a moment.'],
    [
        'audio_gone_recorded',
        'The audio is gone and there was never another copy. The transcript below is what remains.',
    ],
    ['audio_gone_uploaded', 'The saved audio is gone. Import the original file again to re-transcribe it.'],
    ['audio_storage_unavailable', 'Audio storage is briefly unavailable. Try again in a minute.'],
]);

/** The sentence for a refusal code; `fallback` (describeError's) for any other failure. */
export function reprocessFailureMessage(code: string | null, fallback: string): string {
    return (code === null ? undefined : MESSAGES.get(code)) ?? fallback;
}
