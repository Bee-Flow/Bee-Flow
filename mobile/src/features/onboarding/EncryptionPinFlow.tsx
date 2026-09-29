/**
 * The encryption-PIN screens, as one component with a mode.
 *
 * Setup and unlock are two routes because the auth stage machine has two
 * stages, but they are one flow: an unlock can discover it is really a setup
 * (the server answers `needsSetup` when an SSO account has never chosen a PIN),
 * and a forgotten PIN turns a setup into a recovery. Splitting the UI would
 * mean navigating between routes the auth gate would immediately bounce back —
 * it redirects on stage, and the stage does not change until the flow
 * finishes. So the whole flow lives in one component and switches locally,
 * which is also how the web app does it (agent-hub/src/pages/EncryptionSetup.jsx).
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { AuthShell, TextLink } from './AuthShell';
import {
    EncryptionAlreadySetUpError,
    MIN_PIN_LENGTH,
    recoverWithRecoveryKey,
    registerEncryptionPin,
    unlockEncryptionPin,
    WrongPinError,
} from './encryption';
import { RecoveryKeyCard } from './RecoveryKeyCard';
import * as vault from '../../auth/vault';
import { useTheme } from '../../theme/ThemeProvider';
import { Button } from '../../ui/Button';
import { Banner, describeError } from '../../ui/Feedback';
import { TextField } from '../../ui/Input';
import { Text } from '../../ui/Text';

export interface EncryptionPinFlowProps {
    /** Which stage sent the user here. An unlock can still fall into setup. */
    mode: 'setup' | 'unlock';
    /** Called once the DEK is available and the server session is unblocked. */
    onDone: () => void;
    /** Rendered under the form — usually "sign out". */
    footer?: React.ReactNode;
}

type Step = 'form' | 'recover' | 'saved-key';

export function EncryptionPinFlow({ mode, onDone, footer }: EncryptionPinFlowProps) {
    const theme = useTheme();

    // The *effective* mode. An unlock that discovers `needsSetup` becomes a
    // setup in place rather than routing somewhere the gate would undo.
    const [setupMode, setSetupMode] = useState(mode === 'setup');
    const [step, setStep] = useState<Step>('form');

    const [pin, setPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [recoveryInput, setRecoveryInput] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmNewPin, setConfirmNewPin] = useState('');

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set when the server refused to overwrite an existing key (HTTP 409). */
    const [replaceWarning, setReplaceWarning] = useState<string | null>(null);
    const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

    const runSetup = async (confirmReplace: boolean) => {
        setError(null);
        if (pin.length < MIN_PIN_LENGTH) {
            setError(`Your PIN needs at least ${MIN_PIN_LENGTH} characters.`);
            return;
        }
        if (pin !== confirmPin) {
            setError('Those two PINs are not the same.');
            return;
        }
        setBusy(true);
        try {
            const result = await registerEncryptionPin(pin, { confirmReplace });
            if (result.dek) vault.setDek(result.dek);
            setPin('');
            setConfirmPin('');
            setReplaceWarning(null);
            if (result.recoveryKey) {
                setRecoveryKey(result.recoveryKey);
                setStep('saved-key');
            } else {
                // The legacy endpoint can complete without minting a key. There
                // is nothing to show, so do not invent a ceremony for it.
                onDone();
            }
        } catch (err) {
            if (err instanceof EncryptionAlreadySetUpError) {
                setReplaceWarning(err.message);
            } else {
                setError(describeError(err).message);
            }
        } finally {
            setBusy(false);
        }
    };

    const runUnlock = async () => {
        setError(null);
        if (!pin) {
            setError('Enter your encryption PIN.');
            return;
        }
        setBusy(true);
        try {
            const result = await unlockEncryptionPin(pin);
            if (result.needsSetup) {
                // Not a failure: this account has never chosen a PIN.
                setSetupMode(true);
                setConfirmPin('');
                setError(null);
                return;
            }
            if (result.dek) vault.setDek(result.dek);
            setPin('');
            onDone();
        } catch (err) {
            setError(
                err instanceof WrongPinError
                    ? 'That PIN is not correct.'
                    : describeError(err).message,
            );
        } finally {
            setBusy(false);
        }
    };

    const runRecovery = async () => {
        setError(null);
        if (!recoveryInput.trim()) {
            setError('Paste the recovery key you saved when you set this up.');
            return;
        }
        if (newPin.length < MIN_PIN_LENGTH) {
            setError(`Your new PIN needs at least ${MIN_PIN_LENGTH} characters.`);
            return;
        }
        if (newPin !== confirmNewPin) {
            setError('Those two PINs are not the same.');
            return;
        }
        setBusy(true);
        try {
            const result = await recoverWithRecoveryKey(recoveryInput, newPin);
            setRecoveryInput('');
            setNewPin('');
            setConfirmNewPin('');
            if (result.recoveryKey) {
                // Recovery mints a NEW key and retires the old one, so this
                // showing is as one-time as the first was.
                setRecoveryKey(result.recoveryKey);
                setStep('saved-key');
            } else {
                onDone();
            }
        } catch (err) {
            setError(describeError(err).message);
        } finally {
            setBusy(false);
        }
    };

    if (step === 'saved-key' && recoveryKey) {
        return (
            <AuthShell icon="key" tone="success" title="Encryption is on">
                <RecoveryKeyCard secret={recoveryKey} onConfirm={onDone} />
            </AuthShell>
        );
    }

    if (step === 'recover') {
        return (
            <AuthShell
                icon="life-buoy"
                tone="warning"
                title="Use your recovery key"
                subtitle="Your recovery key unwraps your data and lets you set a new PIN. The old PIN stops working."
                footer={
                    <TextLink
                        label="Back to PIN entry"
                        tone="tertiary"
                        onPress={() => {
                            setStep('form');
                            setError(null);
                        }}
                    />
                }
            >
                {error ? <Banner tone="error">{error}</Banner> : null}

                <TextField
                    label="Recovery key"
                    value={recoveryInput}
                    onChangeText={setRecoveryInput}
                    placeholder="A1B2C3D4-E5F6…"
                    multiline
                    maxLines={3}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    hint="Case and dashes do not matter."
                />
                <TextField
                    label="New PIN"
                    value={newPin}
                    onChangeText={setNewPin}
                    secure
                    textContentType="newPassword"
                    hint={`At least ${MIN_PIN_LENGTH} characters.`}
                />
                <TextField
                    label="Confirm new PIN"
                    value={confirmNewPin}
                    onChangeText={setConfirmNewPin}
                    secure
                    returnKeyType="go"
                    onSubmitEditing={() => void runRecovery()}
                />
                <Button
                    label="Recover and set new PIN"
                    onPress={() => void runRecovery()}
                    size="lg"
                    fullWidth
                    loading={busy}
                />
            </AuthShell>
        );
    }

    return (
        <AuthShell
            icon={setupMode ? 'shield' : 'lock'}
            title={setupMode ? 'Set an encryption PIN' : 'Unlock your data'}
            subtitle={
                setupMode
                    ? 'Your PIN encrypts everything you keep in Bee Flow. It is separate from how you sign in, and the server never sees it.'
                    : 'Enter the encryption PIN you chose. Your data stays unreadable until you do.'
            }
            footer={footer}
        >
            {replaceWarning ? (
                <View style={{ gap: theme.spacing.md }}>
                    <Banner tone="error" icon="alert-octagon">
                        {replaceWarning}
                    </Banner>
                    <Text variant="caption" tone="secondary">
                        This account already has an encryption key. Setting a new one
                        makes everything encrypted under the old key permanently
                        unreadable — there is no undo and no copy anywhere else.
                    </Text>
                    <Button
                        label="Replace the key and lose that data"
                        onPress={() => void runSetup(true)}
                        variant="destructive"
                        fullWidth
                        loading={busy}
                    />
                    <Button
                        label="Cancel"
                        onPress={() => setReplaceWarning(null)}
                        variant="ghost"
                        fullWidth
                    />
                </View>
            ) : (
                <>
                    {error ? <Banner tone="error">{error}</Banner> : null}

                    <TextField
                        label={setupMode ? 'Choose an encryption PIN' : 'Encryption PIN'}
                        value={pin}
                        onChangeText={setPin}
                        secure
                        autoFocus
                        textContentType={setupMode ? 'newPassword' : 'password'}
                        returnKeyType={setupMode ? 'next' : 'go'}
                        onSubmitEditing={setupMode ? undefined : () => void runUnlock()}
                        hint={setupMode ? `At least ${MIN_PIN_LENGTH} characters.` : undefined}
                    />

                    {setupMode ? (
                        <TextField
                            label="Confirm PIN"
                            value={confirmPin}
                            onChangeText={setConfirmPin}
                            secure
                            returnKeyType="go"
                            onSubmitEditing={() => void runSetup(false)}
                        />
                    ) : null}

                    <Button
                        label={setupMode ? 'Turn on encryption' : 'Unlock'}
                        onPress={() => void (setupMode ? runSetup(false) : runUnlock())}
                        size="lg"
                        fullWidth
                        loading={busy}
                    />

                    {setupMode ? (
                        <Text variant="caption" tone="tertiary" center>
                            Bee Flow cannot reset this PIN for you. You will get a
                            recovery key on the next screen — that is the only other
                            way in.
                        </Text>
                    ) : (
                        <TextLink
                            label="Forgot your PIN? Use your recovery key"
                            onPress={() => {
                                setStep('recover');
                                setError(null);
                            }}
                        />
                    )}
                </>
            )}
        </AuthShell>
    );
}
