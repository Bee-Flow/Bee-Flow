/** The account's photo, and the button that replaces it. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Avatar, Button, Icon, Text, useToast } from '@/shared/ui';

import { useUpdateProfile } from '../hooks/mutations';
import { usePickAvatar } from '../hooks/usePickAvatar';

export function AvatarBlock() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const { user } = useAuth();
    const save = useUpdateProfile();
    const pick = usePickAvatar((dataUri) =>
        save.mutate(
            { avatar: dataUri, avatarType: 'image' },
            { onSuccess: () => toast('Photo updated', 'success') },
        ),
    );

    return (
        <View style={styles.block}>
            <Avatar name={user?.displayName || '?'} uri={user?.avatar ?? null} size={88} />
            <Button
                label={save.isPending ? 'Saving…' : 'Change photo'}
                variant="secondary"
                loading={save.isPending}
                onPress={() => void pick()}
                icon={<Icon name="Camera" size={16} color={theme.colors.textPrimary} />}
            />
            {save.isError ? (
                <Text variant="caption" tone="error" center accessibilityLiveRegion="polite">
                    {describeError(save.error).message}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        block: { alignItems: 'center', gap: theme.spacing.md },
    });
