/**
 * Change password. The data encryption key is re-wrapped under the new one,
 * which is why the current password is required.
 */

import React from 'react';

import { translate, useTranslation } from '@/core/i18n';
import { FormSheet, useForm, type UseFormOptions } from '@/shared/patterns';
import { TextField, useToast } from '@/shared/ui';

import { useChangePassword } from '../hooks/mutations';
import { passwordCheck } from '../model/password';

type PasswordForm = { current: string; next: string; repeat: string };

const EMPTY: PasswordForm = { current: '', next: '', repeat: '' };

// The two mistakes worth saying out loud. An empty field says nothing; it only
// keeps the button off (passwordCheck's `ready`).
const RULES: UseFormOptions<PasswordForm>['validate'] = {
    next: [(next) => (passwordCheck('', next, '').tooShort ? translate('mobile.security.password_short', 'Too short — eight characters minimum.') : null)],
    repeat: [(repeat, { next }) => (passwordCheck('', next, repeat).mismatch ? translate('mobile.security.password_mismatch', 'These do not match.') : null)],
};

export function PasswordSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const change = useChangePassword();
    const form = useForm({
        initial: EMPTY,
        validate: RULES,
        onSubmit: ({ current, next }) => change.mutateAsync({ current, next }),
    });
    const { current, next, repeat } = form.values;

    const submit = async () => {
        if (!(await form.submit())) return;
        toast(t('changepw.success', 'Password changed successfully.'), 'success');
        form.reset(EMPTY);
        onClose();
    };

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('changepw.title', 'Change password')}
            subtitle={t('mobile.security.password_rewrap', 'Your data key is re-wrapped under the new password')}
            submitLabel={t('changepw.update', 'Update password')}
            onSubmit={() => void submit()}
            canSubmit={form.canSubmit && passwordCheck(current, next, repeat).ready}
            submitting={form.submitting}
            error={form.submitError}
        >
            <TextField
                label={t('changepw.current', 'Current password')}
                {...form.field('current')}
                secure
                textContentType="password"
                autoComplete="current-password"
            />
            <TextField
                label={t('changepw.new', 'New password')}
                {...form.field('next')}
                secure
                textContentType="newPassword"
                autoComplete="new-password"
                hint={t('mobile.security.password_hint', 'At least eight characters, and not built from your name or email.')}
            />
            <TextField label={t('changepw.confirm', 'Confirm new password')} {...form.field('repeat')} secure autoComplete="new-password" />
        </FormSheet>
    );
}
