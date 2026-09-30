/** A one-field sheet for the actions that need a current TOTP or recovery code. */

import React, { useState } from 'react';

import { FormSheet } from '@/shared/patterns';
import { TextField } from '@/shared/ui';

export function CodeSheet({
    visible,
    onClose,
    title,
    subtitle,
    actionLabel,
    onSubmit,
    pending,
    error,
    destructive = false,
}: {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle: string;
    actionLabel: string;
    onSubmit: (code: string) => void;
    pending: boolean;
    /** The failed submit, if any; FormSheet puts it into words. */
    error: unknown;
    destructive?: boolean;
}) {
    const [code, setCode] = useState('');
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            submitLabel={actionLabel}
            variant={destructive ? 'danger' : 'primary'}
            onSubmit={() => onSubmit(code.trim())}
            canSubmit={code.trim().length >= 6}
            submitting={pending}
            error={error}
        >
            <TextField
                label="Code"
                value={code}
                onChangeText={setCode}
                keyboardType="default"
                autoCapitalize="none"
                autoComplete="one-time-code"
                hint="A six-digit code from your authenticator, or one recovery code."
            />
        </FormSheet>
    );
}
