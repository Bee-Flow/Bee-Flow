/**
 * The encryption-PIN flow's state and its three actions: set a PIN, unlock
 * with one, or recover with the saved key and set a new one.
 *
 * All of it lives here, above the forms, so switching between PIN entry and
 * recovery keeps what was typed — and so an unlock that discovers `needsSetup`
 * can turn into a setup in place (see EncryptionPinFlow for why that cannot be
 * a route change).
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import * as vault from '@/core/auth/vault';
import { translate } from '@/core/i18n';

import {
    EncryptionAlreadySetUpError,
    recoverWithRecoveryKey,
    registerEncryptionPin,
    unlockEncryptionPin,
    WrongPinError,
} from '../api/encryption';
import { pinSetupProblem, pinUnlockProblem, recoveryProblem } from '../model/pin';

export type PinStep = 'form' | 'recover' | 'saved-key';

export interface PinFields {
    pin: string;
    confirmPin: string;
    recoveryInput: string;
    newPin: string;
    confirmNewPin: string;
}

const EMPTY: PinFields = { pin: '', confirmPin: '', recoveryInput: '', newPin: '', confirmNewPin: '' };

interface Flow {
    fields: PinFields;
    set: (patch: Partial<PinFields>) => void;
    setError: (message: string | null) => void;
    setBusy: (busy: boolean) => void;
    setReplaceWarning: (message: string | null) => void;
    setSetupMode: (setup: boolean) => void;
    /** A freshly minted recovery key goes on screen; no key means straight to onDone. */
    showKeyOrFinish: (recoveryKey: string | null) => void;
    onDone: () => void;
}

/** Validate, then run `work` with the busy flag up and any failure worded. */
async function attempt(flow: Flow, problem: string | null, work: () => Promise<void>, onError?: (err: unknown) => boolean) {
    flow.setError(problem);
    if (problem) return;
    flow.setBusy(true);
    try {
        await work();
    } catch (err) {
        if (!onError?.(err)) flow.setError(describeError(err).message);
    } finally {
        flow.setBusy(false);
    }
}

function runSetup(flow: Flow, confirmReplace: boolean) {
    const { pin, confirmPin } = flow.fields;
    return attempt(
        flow,
        pinSetupProblem(pin, confirmPin),
        async () => {
            const result = await registerEncryptionPin(pin, { confirmReplace });
            if (result.dek) vault.setDek(result.dek);
            flow.set({ pin: '', confirmPin: '' });
            flow.setReplaceWarning(null);
            // The legacy endpoint can complete without minting a key. There is
            // nothing to show then, so do not invent a ceremony for it.
            flow.showKeyOrFinish(result.recoveryKey);
        },
        // HTTP 409: the account already has a key. Asked about, not shown as an error.
        (err) => {
            if (!(err instanceof EncryptionAlreadySetUpError)) return false;
            flow.setReplaceWarning(err.message);
            return true;
        },
    );
}

function runUnlock(flow: Flow) {
    const { pin } = flow.fields;
    return attempt(
        flow,
        pinUnlockProblem(pin),
        async () => {
            const result = await unlockEncryptionPin(pin);
            if (result.needsSetup) {
                // Not a failure: this account has never chosen a PIN.
                flow.setSetupMode(true);
                flow.set({ confirmPin: '' });
                return;
            }
            if (result.dek) vault.setDek(result.dek);
            flow.set({ pin: '' });
            flow.onDone();
        },
        (err) => {
            if (!(err instanceof WrongPinError)) return false;
            flow.setError(translate('mobile.onboarding.pin_wrong', 'That PIN is not correct.'));
            return true;
        },
    );
}

function runRecovery(flow: Flow) {
    const { recoveryInput, newPin, confirmNewPin } = flow.fields;
    return attempt(flow, recoveryProblem(recoveryInput, newPin, confirmNewPin), async () => {
        const result = await recoverWithRecoveryKey(recoveryInput, newPin);
        flow.set({ recoveryInput: '', newPin: '', confirmNewPin: '' });
        // Recovery mints a NEW key and retires the old one, so this showing is
        // as one-time as the first was.
        flow.showKeyOrFinish(result.recoveryKey);
    });
}

export function usePinFlow(mode: 'setup' | 'unlock', onDone: () => void) {
    // The *effective* mode: an unlock that discovers `needsSetup` becomes a setup.
    const [setupMode, setSetupMode] = useState(mode === 'setup');
    const [step, setStep] = useState<PinStep>('form');
    const [fields, setFields] = useState<PinFields>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set when the server refused to overwrite an existing key (HTTP 409). */
    const [replaceWarning, setReplaceWarning] = useState<string | null>(null);
    const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

    const flow: Flow = {
        fields,
        set: (patch) => setFields((current) => ({ ...current, ...patch })),
        setError,
        setBusy,
        setReplaceWarning,
        setSetupMode,
        showKeyOrFinish: (key) => {
            if (!key) return onDone();
            setRecoveryKey(key);
            setStep('saved-key');
        },
        onDone,
    };

    return {
        setupMode,
        step,
        fields,
        set: flow.set,
        busy,
        error,
        replaceWarning,
        recoveryKey,
        submit: () => void (setupMode ? runSetup(flow, false) : runUnlock(flow)),
        replaceKey: () => void runSetup(flow, true),
        keepKey: () => setReplaceWarning(null),
        recover: () => void runRecovery(flow),
        goTo: (next: 'form' | 'recover') => {
            setStep(next);
            setError(null);
        },
    };
}
