/** A label's name, being edited in place in the manage list. */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, IconButton, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'flex-end' as const,
        gap: theme.spacing.sm,
        padding: theme.spacing.lg,
    },
    field: { flex: 1 },
});

export function LabelRenameRow({
    initial,
    busy,
    onSave,
    onCancel,
}: {
    initial: string;
    busy: boolean;
    onSave: (name: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [value, setValue] = useState(initial);
    return (
        <View style={styles.row}>
            <TextField
                label={t('mobile.chat.details.rename_label', 'Rename label')}
                value={value}
                onChangeText={setValue}
                autoFocus
                returnKeyType="done"
                containerStyle={styles.field}
                onSubmitEditing={() => value.trim() && onSave(value.trim())}
            />
            <Button
                label={t('common.save', 'Save')}
                variant="secondary"
                onPress={() => onSave(value.trim())}
                disabled={!value.trim() || busy}
                loading={busy}
            />
            <IconButton
                icon={<Icon name="X" size={18} color={theme.colors.textMuted} />}
                accessibilityLabel={t('mobile.chat.details.cancel_rename', 'Cancel renaming')}
                onPress={onCancel}
            />
        </View>
    );
}
