/**
 * File a GDPR data-subject request against your own account, through the
 * public DSR channel. Two states in one sheet: the form, then the receipt.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useSubmitDsrRequest } from '@/features/org';
import { Button, Sheet } from '@/shared/ui';

import { DsrForm, type DsrDraft } from './DsrForm';
import { DsrReceipt } from './DsrReceipt';
import { looksLikeEmail } from '../model/dsr';

export function DsrSheet({
    visible,
    onClose,
    defaultEmail,
    onFiled,
}: {
    visible: boolean;
    onClose: () => void;
    defaultEmail: string;
    onFiled: () => void;
}) {
    const [draft, setDraft] = useState<DsrDraft>({ type: 'access', email: defaultEmail, notes: '' });
    const [reference, setReference] = useState<number | null>(null);
    const t = useTranslation();
    const submit = useSubmitDsrRequest();

    const file = () =>
        submit.mutate(
            {
                subject_email: draft.email.trim(),
                request_type: draft.type,
                notes: draft.notes.trim(),
            },
            {
                onSuccess: (result) => {
                    setReference(result?.id ?? null);
                    onFiled();
                },
            },
        );

    const close = () => {
        setReference(null);
        setDraft((previous) => ({ ...previous, notes: '' }));
        onClose();
    };

    const filed = reference !== null;
    return (
        <Sheet
            visible={visible}
            onClose={close}
            title={filed ? t('dsr_public.submitted_title', 'Request received') : t('mobile.account.dsr_title', 'Request your data')}
            subtitle={filed ? undefined : t('mobile.account.dsr_subtitle', 'Handled by your organisation within thirty days')}
            footer={
                filed ? (
                    <Button label={t('automations.sharing.done', 'Done')} variant="secondary" onPress={close} fullWidth />
                ) : (
                    <Button
                        label={t('mobile.account.dsr_file', 'File request')}
                        onPress={file}
                        disabled={!looksLikeEmail(draft.email)}
                        loading={submit.isPending}
                        fullWidth
                    />
                )
            }
        >
            {filed ? (
                <DsrReceipt reference={reference} />
            ) : (
                <DsrForm
                    draft={draft}
                    onChange={(next) => setDraft((previous) => ({ ...previous, ...next }))}
                    error={submit.isError ? submit.error : null}
                />
            )}
        </Sheet>
    );
}
