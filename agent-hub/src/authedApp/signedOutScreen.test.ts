import { describe, expect, it } from 'vitest';
import { readSignInRefusal, signedOutScreen } from './signedOutScreen';

const answer = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('signedOutScreen', () => {
    it('standalone: the sign-in form', () => {
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: null, embedded: false })).toBe('login');
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: 'failed', embedded: false })).toBe('login');
    });

    it('inside Nextcloud: never the sign-in form', () => {
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: null, embedded: true })).toBe('nc_sign_in_failed');
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: 'failed', embedded: true })).toBe('nc_sign_in_failed');
    });

    it('pending onboarding: the setup-in-progress screen', () => {
        expect(signedOutScreen({ ncOnboardingState: 'pending', diagnosticsState: null, embedded: true })).toBe('nc_onboarding_pending');
        expect(signedOutScreen({ ncOnboardingState: 'pending', diagnosticsState: 'awaiting_email_verification', embedded: true })).toBe('nc_onboarding_pending');
    });

    it('a connector waiting for the e-mail code: the verification screen, embedded or not', () => {
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: 'awaiting_email_verification', embedded: true })).toBe('email_verification');
        expect(signedOutScreen({ ncOnboardingState: null, diagnosticsState: 'awaiting_email_verification', embedded: false })).toBe('email_verification');
    });
});

describe('readSignInRefusal', () => {
    it('reads the code and the sentence of a provisioning gate', async () => {
        const refusal = await readSignInRefusal(answer(403, { error: 'Setup in progress', code: 'NC_ONBOARDING_PENDING' }));
        expect(refusal).toEqual({ status: 403, code: 'NC_ONBOARDING_PENDING', message: 'Setup in progress' });
    });

    it('keeps the sentence of a 409, without a code when none is sent', async () => {
        expect(await readSignInRefusal(answer(409, { error: ' Already linked. ' }))).toEqual({ status: 409, code: null, message: 'Already linked.' });
    });

    it('does not pass on the text of other statuses', async () => {
        expect(await readSignInRefusal(answer(502, { error: 'Tenant key not configured' }))).toEqual({ status: 502, code: null, message: null });
        expect(await readSignInRefusal(answer(401, { error: 'Unauthorized', code: 'x' }))).toEqual({ status: 401, code: 'x', message: null });
    });

    it('a body that is not JSON, or not an object, is a refusal without details', async () => {
        expect(await readSignInRefusal(answer(403, '<html>Forbidden</html>'))).toEqual({ status: 403, code: null, message: null });
        expect(await readSignInRefusal(answer(403, ['x']))).toEqual({ status: 403, code: null, message: null });
        expect(await readSignInRefusal(answer(403, { error: 5, code: 7 }))).toEqual({ status: 403, code: null, message: null });
    });
});
