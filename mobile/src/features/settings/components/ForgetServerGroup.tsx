/**
 * Forgetting this server: the last group, on its own, because it is the most
 * destructive thing on the screen. `forgetServer()` wipes the vault, clears
 * every cached query and returns to the first-run screen. It asks first.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Button, Group } from '@/shared/ui';

export function ForgetServerGroup() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const confirm = useConfirm();
    const { forgetServer } = useAuth();

    const confirmForget = async () => {
        const ok = await confirm({
            title: t('mobile.settings.forget_title', 'Forget this server?'),
            message: t('mobile.settings.forget_message', 'You are signed out, and Bee Flow deletes the encryption key stored on this phone and everything it has cached, then asks which server to use. Nothing on the server is deleted.'),
            confirmLabel: t('mobile.settings.forget_server', 'Forget server'),
        });
        if (ok) void forgetServer();
    };

    return (
        <Group footer={t('mobile.settings.forget_footer', 'Signs you out and removes this server from the app.')}>
            <View style={styles.actions}>
                <Button
                    label={t('mobile.settings.forget_row', 'Forget this server')}
                    variant="danger"
                    onPress={() => void confirmForget()}
                    fullWidth
                />
            </View>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        actions: { padding: theme.spacing.lg },
    });
