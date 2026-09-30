/**
 * Short text, long text, email, number and date — every answer that is typed.
 * The keyboard follows the type; the length caps are the server's own
 * (a longer answer would be cut there without a word). A date is typed as
 * YYYY-MM-DD, the format the form submits, with "Today" for the commonest
 * answer: there is no date picker in this app's dependency set.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { MAX_STRING_VALUE, MAX_TEXTAREA_LEN } from '@/features/forms/model/contract';
import { Chip, TextField } from '@/shared/ui';

import { labelOf, type AnswerProps } from './types';

type Keyboard = 'default' | 'email-address' | 'numeric';

/**
 * "numeric" is Android's number pad with a minus and a decimal key: enough
 * for -1,5 and for 2026-09-30. ("numbers-and-punctuation" is iOS-only; Android
 * opened its letter keyboard for it.) A decimal comma is read as a decimal by
 * the contract (model/contract.ts).
 */
const KEYBOARD: Readonly<Record<string, Keyboard>> = {
    email: 'email-address',
    number: 'numeric',
    date: 'numeric',
};

function todayIso(now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function TextAnswer({ field, value, error, disabled, onChange }: AnswerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const long = field.type === 'textarea';
    const date = field.type === 'date';
    const typed = field.type === 'email' || field.type === 'number' || date;
    const placeholder = date ? field.placeholder || t('mobile.forms.date_format', 'YYYY-MM-DD') : field.placeholder;
    return (
        <View style={styles.box}>
            <TextField
                label={labelOf(field)}
                value={typeof value === 'string' ? value : ''}
                onChangeText={onChange}
                placeholder={placeholder || undefined}
                hint={field.help || undefined}
                error={error}
                editable={!disabled}
                multiline={long}
                maxLines={long ? 10 : undefined}
                maxLength={long ? MAX_TEXTAREA_LEN : MAX_STRING_VALUE}
                keyboardType={KEYBOARD[field.type] ?? 'default'}
                autoCapitalize={typed ? 'none' : 'sentences'}
                autoCorrect={!typed}
                testID={`fill-${field.name}`}
            />
            {date ? (
                <View style={styles.row}>
                    <Chip label={t('mobile.forms.fill.today', 'Today')} onPress={() => onChange(todayIso())} disabled={disabled} />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing.sm } satisfies ViewStyle,
    row: { flexDirection: 'row' } satisfies ViewStyle,
});
