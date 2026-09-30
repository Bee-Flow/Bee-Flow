/**
 * Security.
 *
 * This is the screen a privacy product is judged on, so it says what is true
 * rather than what sounds reassuring — about app lock (AppLockGroup), the
 * password that also unlocks your data (PasswordGroup), a recovery key that
 * cannot be reissued (EncryptionGroup) and sessions the server cannot list or
 * revoke (SessionsGroup). Two-factor RECOVERY CODES are a different thing from
 * the encryption recovery key, and can be regenerated from here.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useToast, GroupedScroll, Screen, ScreenHeader } from '@/shared/ui';

import { AppLockGroup } from '../components/AppLockGroup';
import { CodeSheet } from '../components/CodeSheet';
import { EncryptionGroup } from '../components/EncryptionGroup';
import { EnrolSheet } from '../components/EnrolSheet';
import { MfaGroup } from '../components/MfaGroup';
import { PasswordGroup } from '../components/PasswordGroup';
import { PasswordSheet } from '../components/PasswordSheet';
import { RecoveryCodesSheet } from '../components/RecoveryCodesSheet';
import { SessionsGroup } from '../components/SessionsGroup';
import { useDisableMfa, useRegenerateRecoveryCodes } from '../hooks/mutations';
import { useMfaStatus } from '../hooks/queries';
import { useAppLock } from '../hooks/useAppLock';

export function SecurityScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const lock = useAppLock();
    const mfa = useMfaStatus();
    const disable = useDisableMfa();
    const regenerate = useRegenerateRecoveryCodes();

    const [passwordSheet, setPasswordSheet] = useState(false);
    const [enrolSheet, setEnrolSheet] = useState(false);
    const [codesSheet, setCodesSheet] = useState<string[] | null>(null);
    const [disableSheet, setDisableSheet] = useState(false);
    const [regenSheet, setRegenSheet] = useState(false);

    const turnOff = (code: string) =>
        disable.mutate(code, {
            onSuccess: () => {
                setDisableSheet(false);
                toast(t('mobile.security.mfa_off_toast', 'Two-factor turned off'), 'neutral');
            },
        });

    const newCodes = (code: string) =>
        regenerate.mutate(code, {
            onSuccess: (result) => {
                setRegenSheet(false);
                setCodesSheet(result?.recoveryCodes ?? []);
            },
        });

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('settings.security', 'Security')} subtitle={t('mobile.security.subtitle', 'This device, and this account')} />

            <GroupedScroll>
                <AppLockGroup lock={lock} />
                <PasswordGroup mfa={mfa.data} onChange={() => setPasswordSheet(true)} />
                <MfaGroup
                    mfa={mfa}
                    onSetUp={() => setEnrolSheet(true)}
                    onRegenerate={() => setRegenSheet(true)}
                    onTurnOff={() => setDisableSheet(true)}
                />
                <EncryptionGroup />
                <SessionsGroup />
            </GroupedScroll>

            <PasswordSheet visible={passwordSheet} onClose={() => setPasswordSheet(false)} />

            <EnrolSheet
                visible={enrolSheet}
                onClose={() => setEnrolSheet(false)}
                onEnrolled={(codes) => {
                    setEnrolSheet(false);
                    setCodesSheet(codes);
                }}
            />

            <CodeSheet
                visible={disableSheet}
                onClose={() => setDisableSheet(false)}
                title={t('mobile.security.mfa_off_title', 'Turn off two-factor')}
                subtitle={t('mfa.confirm_with_code_or_recovery', 'Enter a 6-digit code or a recovery code to confirm')}
                actionLabel={t('mobile.security.mfa_off_action', 'Turn off')}
                destructive
                pending={disable.isPending}
                error={disable.isError ? disable.error : undefined}
                onSubmit={turnOff}
            />

            <CodeSheet
                visible={regenSheet}
                onClose={() => setRegenSheet(false)}
                title={t('mobile.security.new_codes_title', 'New recovery codes')}
                subtitle={t('mobile.security.new_codes_subtitle', 'Your existing codes stop working immediately')}
                actionLabel={t('mfa.regenerate', 'Regenerate')}
                pending={regenerate.isPending}
                error={regenerate.isError ? regenerate.error : undefined}
                onSubmit={newCodes}
            />

            <RecoveryCodesSheet codes={codesSheet} onClose={() => setCodesSheet(null)} />
        </Screen>
    );
}
