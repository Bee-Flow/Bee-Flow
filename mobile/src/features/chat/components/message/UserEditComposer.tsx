/**
 * A question rewritten in place (the web's UserEditComposer): the bubble
 * becomes a field with its words, and "Save & Regenerate" cuts the
 * conversation at this question and asks the new words instead.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    box: { alignSelf: 'flex-end' as const, width: '85%' as const, paddingHorizontal: theme.spacing.lg, paddingVertical: 6, gap: theme.spacing.sm },
    actions: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, gap: theme.spacing.sm },
});

export function UserEditComposer({
    initial,
    onCancel,
    onSubmit,
}: {
    initial: string;
    onCancel: () => void;
    onSubmit: (text: string) => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [text, setText] = useState(initial);
    return (
        <View style={styles.box}>
            <TextField
                value={text}
                onChangeText={setText}
                multiline
                autoFocus
                selectTextOnFocus
                accessibilityLabel={t('chat.msg.edit_label', 'Edit your message')}
            />
            <View style={styles.actions}>
                <Button label={t('chat.msg.edit_cancel', 'Cancel')} variant="ghost" size="sm" onPress={onCancel} />
                <Button
                    label={t('chat.msg.edit_save', 'Save & Regenerate')}
                    iconName="Send"
                    size="sm"
                    disabled={!text.trim()}
                    onPress={() => onSubmit(text.trim())}
                />
            </View>
        </View>
    );
}
