/** The meeting chat's input row: the question field and Send / Stop. */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, TextField } from '@/shared/ui';

export function MeetingChatInput({
    value,
    onChange,
    onSend,
    streaming,
    onStop,
}: {
    value: string;
    onChange: (text: string) => void;
    onSend: () => void;
    streaming: boolean;
    onStop: () => void;
}) {
    const theme = useTheme();
    return (
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-end' }}>
            <TextField
                value={value}
                onChangeText={onChange}
                placeholder="Ask about this meeting"
                multiline
                maxLines={4}
                containerStyle={{ flex: 1 }}
                onSubmitEditing={onSend}
                accessibilityLabel="Ask about this meeting"
            />
            {streaming ? (
                <IconButton
                    icon={<Icon name="Square" size={18} color={theme.colors.textPrimary} />}
                    accessibilityLabel="Stop answering"
                    onPress={onStop}
                />
            ) : (
                <IconButton
                    icon={<Icon name="ArrowUp" size={20} color={theme.colors.accentPrimary} />}
                    accessibilityLabel="Send"
                    onPress={onSend}
                    disabled={!value.trim()}
                    tone="accent"
                />
            )}
        </View>
    );
}
