/**
 * TOTP enrolment.
 *
 * `POST /auth/mfa/setup` is idempotent for ten minutes and returns a rendered
 * QR as a data URI, so the phone does not need a QR library — and re-opening
 * this sheet shows the SAME secret the authenticator already scanned.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

import { EnrolmentCode } from './EnrolmentCode';
import { useEnableMfa } from '../hooks/mutations';

export function EnrolSheet({
    visible,
    onClose,
    onEnrolled,
}: {
    visible: boolean;
    onClose: () => void;
    onEnrolled: (codes: string[]) => void;
}) {
    const t = useTranslation();
    const [code, setCode] = useState('');
    const enable = useEnableMfa();

    const submit = () =>
        enable.mutate(code.trim(), {
            onSuccess: (result) => {
                setCode('');
                onEnrolled(result?.recoveryCodes ?? []);
            },
        });

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.security.mfa_setup', 'Set up two-factor')}
            subtitle={t('mobile.security.enrol_subtitle', 'Scan the code with your authenticator app')}
            submitLabel={t('mobile.security.enrol_submit', 'Turn on two-factor')}
            onSubmit={submit}
            canSubmit={code.trim().length >= 6}
            submitting={enable.isPending}
            error={enable.isError ? enable.error : undefined}
        >
            <EnrolmentCode open={visible} />
            <TextField
                label={t('mobile.security.enrol_code', 'Six-digit code from the app')}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
            />
        </FormSheet>
    );
}
