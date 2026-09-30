/** Two-factor's state as one row: loading, the refusal, or On/Off. */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, BadgeRow, Icon, LoadingState, NoteRow, Text } from '@/shared/ui';

import type { MfaStatus } from '../model/types';

export interface MfaQuery {
    data: MfaStatus | null | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
}

export function MfaStatusRow({ mfa }: { mfa: MfaQuery }) {
    const theme = useTheme();
    if (mfa.isLoading) {
        return (
            <NoteRow>
                <LoadingState />
            </NoteRow>
        );
    }
    if (mfa.isError) {
        return (
            <NoteRow>
                <Text variant="caption" tone="error">
                    {describeError(mfa.error).message}
                </Text>
            </NoteRow>
        );
    }
    const on = Boolean(mfa.data?.enabled);
    return (
        <BadgeRow
            label="Status"
            leading={
                <Icon
                    name="Shield"
                    size={16}
                    color={on ? theme.colors.success : theme.colors.textMuted}
                />
            }
        >
            <Badge label={on ? 'On' : 'Off'} tone={on ? 'success' : 'neutral'} />
        </BadgeRow>
    );
}
