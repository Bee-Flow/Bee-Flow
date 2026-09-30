/** What kind of request, for which address, and anything that narrows it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, OptionRow, TextField } from '@/shared/ui';

import { DSR_TYPES, looksLikeEmail } from '../model/dsr';

export interface DsrDraft {
    type: string;
    email: string;
    notes: string;
}

export function DsrForm({
    draft,
    onChange,
    error,
}: {
    draft: DsrDraft;
    onChange: (next: Partial<DsrDraft>) => void;
    error: unknown;
}) {
    const styles = useThemedStyles(makeStyles);
    const badEmail = draft.email.length > 0 && !looksLikeEmail(draft.email);
    return (
        <View style={styles.body}>
            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}

            <View accessibilityRole="radiogroup" style={styles.options}>
                {DSR_TYPES.map((option) => (
                    <OptionRow
                        key={option.id}
                        label={option.label}
                        description={option.description}
                        selected={draft.type === option.id}
                        onPress={() => onChange({ type: option.id })}
                    />
                ))}
            </View>

            <TextField
                label="Your email"
                value={draft.email}
                onChangeText={(email) => onChange({ email })}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                hint="The organisation is identified from this address, so use the one your account is under."
                error={badEmail ? 'That does not look like an email address.' : null}
            />
            <TextField
                label="Anything to add (optional)"
                value={draft.notes}
                onChangeText={(notes) => onChange({ notes })}
                multiline
                maxLines={5}
                placeholder="Which data, or which period, if it helps narrow the request."
            />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        options: { gap: 0 },
    });
