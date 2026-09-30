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

import React from 'react';

import { useTranslation } from '@/core/i18n';

import { AuthShell } from './AuthShell';
import { PinEntryFields } from './PinEntryFields';
import { PinRecoveryForm } from './PinRecoveryForm';
import { RecoveryKeyCard } from './RecoveryKeyCard';
import { ReplaceKeyWarning } from './ReplaceKeyWarning';
import { usePinFlow } from '../hooks/usePinFlow';

export interface EncryptionPinFlowProps {
    /** Which stage sent the user here. An unlock can still fall into setup. */
    mode: 'setup' | 'unlock';
    /** Called once the DEK is available and the server session is unblocked. */
    onDone: () => void;
    /** Rendered under the form — usually "sign out". */
    footer?: React.ReactNode;
}

export function EncryptionPinFlow({ mode, onDone, footer }: EncryptionPinFlowProps) {
    const flow = usePinFlow(mode, onDone);
    const t = useTranslation();

    if (flow.step === 'saved-key' && flow.recoveryKey) {
        return (
            <AuthShell icon="Key" tone="success" title={t('mobile.onboarding.encryption_on', 'Encryption is on')}>
                <RecoveryKeyCard secret={flow.recoveryKey} onConfirm={onDone} />
            </AuthShell>
        );
    }

    if (flow.step === 'recover') {
        return (
            <PinRecoveryForm
                fields={flow.fields}
                set={flow.set}
                error={flow.error}
                busy={flow.busy}
                onRecover={flow.recover}
                onBack={() => flow.goTo('form')}
            />
        );
    }

    return (
        <AuthShell
            icon={flow.setupMode ? 'Shield' : 'Lock'}
            title={
                flow.setupMode
                    ? t('mobile.onboarding.pin_setup_title', 'Set an encryption PIN')
                    : t('encryption.unlock_title', 'Unlock your data')
            }
            subtitle={
                flow.setupMode
                    ? t(
                          'mobile.onboarding.pin_setup_intro',
                          'Your PIN encrypts everything you keep in Bee Flow. It is separate from how you sign in, and the server never sees it.',
                      )
                    : t(
                          'mobile.onboarding.pin_unlock_intro',
                          'Enter the encryption PIN you chose. Your data stays unreadable until you do.',
                      )
            }
            footer={footer}
        >
            {flow.replaceWarning ? (
                <ReplaceKeyWarning
                    warning={flow.replaceWarning}
                    busy={flow.busy}
                    onReplace={flow.replaceKey}
                    onCancel={flow.keepKey}
                />
            ) : (
                <PinEntryFields
                    setupMode={flow.setupMode}
                    fields={flow.fields}
                    set={flow.set}
                    error={flow.error}
                    busy={flow.busy}
                    onSubmit={flow.submit}
                    onForgot={() => flow.goTo('recover')}
                />
            )}
        </AuthShell>
    );
}
