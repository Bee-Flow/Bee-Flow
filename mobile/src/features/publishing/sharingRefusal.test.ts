/**
 * Webpage sharing refused for the licence (`webpage_sharing`, the enterprise
 * split of 2026-10) reads as a sentence on the phone, not as the bare
 * `feature_locked` token the server's gate answers with. Everything else a
 * sharing request can fail with passes through untouched.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/publishing/sharingRefusal.test.ts
 */

import { readableSharingRefusal, sharingRequest, WEBPAGE_SHARING } from './sharingRefusal';
import { ApiError } from '../../api/client';
import { describeError } from '../../ui/Feedback';

const refusal = (error: string, feature = WEBPAGE_SHARING, status = 403) =>
    new ApiError(error, { status, body: { error, feature, required: 'enterprise' } });

describe('readableSharingRefusal', () => {
    it('words "not on your plan", and keeps the status and the body', () => {
        const out = readableSharingRefusal(refusal('feature_locked')) as ApiError;
        expect(out).toBeInstanceOf(ApiError);
        expect(out.message).toMatch(/available on a higher plan/);
        expect(out.message).toMatch(/already shared stays shared/);
        expect(out.status).toBe(403);
        expect((out.body as { feature: string }).feature).toBe(WEBPAGE_SHARING);
        // describeError titles it as a plan matter and shows the sentence.
        const shown = describeError(out);
        expect(shown.title).toBe('Not available on your plan');
        expect(shown.message).not.toMatch(/feature_locked/);
    });

    it('words "ask an admin" when the plan has it and the organisation did not switch it on', () => {
        const out = readableSharingRefusal(refusal('feature_disabled')) as ApiError;
        expect(out.message).toMatch(/ask an admin/);
    });

    it('leaves every other failure alone', () => {
        const other = [
            refusal('feature_locked', 'webpages'),
            refusal('feature_locked', WEBPAGE_SHARING, 402),
            new ApiError('Permission denied', { status: 403, body: { error: 'Permission denied' } }),
            new Error('offline'),
        ];
        for (const err of other) expect(readableSharingRefusal(err)).toBe(err);
    });
});

describe('sharingRequest', () => {
    it('passes an answer through', async () => {
        await expect(sharingRequest(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    });

    it('throws the worded refusal in place of the token', async () => {
        await expect(sharingRequest(async () => { throw refusal('feature_locked'); }))
            .rejects.toThrow(/available on a higher plan/);
    });
});
