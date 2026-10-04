/** The Questions tab's Discard / Save, and why the last save was refused. */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

export function SaveBar({
    dirty,
    locked = false,
    saving,
    error,
    onSave,
    onDiscard,
}: {
    dirty: boolean;
    /** The AI builder holds the automation: nothing can be written until it finishes. */
    locked?: boolean;
    saving: boolean;
    error: unknown;
    onSave: () => void;
    onDiscard: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.bar} testID="form-savebar">
            {error ? (
                <Text variant="caption" tone="error">
                    {describeError(error).message}
                </Text>
            ) : null}
            <View style={styles.buttons}>
                <Button variant="secondary" label={t('forms.page.discard', 'Discard changes')} onPress={onDiscard} disabled={!dirty || saving} />
                <Button label={t('forms.page.save', 'Save')} onPress={onSave} disabled={!dirty || locked} loading={saving} testID="form-save" />
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    bar: {
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
});
