/**
 * The frame every settings tab of the editor shares: a scrolling column, the
 * save's error (or the reason it cannot be sent) above the fields, and the
 * web's "Save changes" docked under them.
 */

import React, { type ReactNode } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button } from '@/shared/ui';

export interface TabFrameProps {
    children: ReactNode;
    /** Omit for a tab without a save (History). */
    save?: {
        dirty: boolean;
        saving: boolean;
        error: unknown;
        onSave: () => void;
        /** A reason the draft cannot be saved as it stands; disables the button. */
        problem?: string | null;
    };
    editable: boolean;
}

export function TabFrame({ children, save, editable }: TabFrameProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const message = save?.problem ?? (save?.error ? describeError(save.error).message : null);
    return (
        <View style={styles.root}>
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                {message ? <Banner tone="error">{message}</Banner> : null}
                {children}
            </ScrollView>
            {save && editable ? (
                <View style={styles.footer}>
                    <Button
                        label={save.dirty ? t('routines.save_changes', 'Save changes') : t('documents.saved', 'Saved')}
                        onPress={save.onSave}
                        disabled={!save.dirty || Boolean(save.problem)}
                        loading={save.saving}
                        fullWidth
                    />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    root: { flex: 1 } satisfies ViewStyle,
    body: { padding: theme.spacing[4], gap: theme.spacing[3], paddingBottom: theme.spacing[8] } satisfies ViewStyle,
    footer: {
        padding: theme.spacing[3],
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
});
