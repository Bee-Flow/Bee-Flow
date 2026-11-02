import { isReauthRequired } from '../components/mfa/ReauthNotice';
import { opaquePinRegister } from '../lib/opaque';
import { errorMessage } from '../utils/caughtError';

export type PinSetupOutcome = { kind: 'done'; recoveryKey: string } | { kind: 'reauth' } | { kind: 'fallback' };

/**
 * Register an encryption PIN through OPAQUE (the PIN never reaches the server).
 * 'fallback' sends the caller to the legacy route. A refusal for want of a
 * recent sign-in is not a reason to fall back: the answer is to sign in again.
 */
export async function setupPinWithOpaque(pin: string): Promise<PinSetupOutcome> {
    try {
        const result = await opaquePinRegister(pin);
        if (result.success && result.recoveryKey) return { kind: 'done', recoveryKey: result.recoveryKey };
    } catch (opaqueErr) {
        if (isReauthRequired(opaqueErr)) return { kind: 'reauth' };
        console.warn('[Encryption] OPAQUE PIN setup failed, falling back to legacy:', errorMessage(opaqueErr));
    }
    return { kind: 'fallback' };
}
