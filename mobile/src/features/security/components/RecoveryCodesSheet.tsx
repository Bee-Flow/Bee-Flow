/**
 * The one-time hand-off of recovery codes.
 *
 * Not dismissible by tapping the backdrop into oblivion without a warning:
 * these are the only way back in if the phone is lost, and the server has
 * already replaced the old set by the time this renders. The warning stays a
 * system dialog: it opens over this sheet and its way out reads "Go back".
 */

import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Sheet, Text, useToast } from '@/shared/ui';

export function RecoveryCodesSheet({
    codes,
    onClose,
}: {
    codes: string[] | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [copied, setCopied] = useState(false);

    const close = () => {
        if (!copied) {
            Alert.alert(
                t('mobile.security.codes_save_title', 'Save these first'),
                t('mobile.security.codes_save_message', 'These codes will not be shown again. If you lose your authenticator without them, an administrator has to reset your two-factor.'),
                [
                    { text: t('mobile.security.codes_go_back', 'Go back'), style: 'cancel' },
                    { text: t('mobile.security.codes_saved', 'I have saved them'), style: 'destructive', onPress: onClose },
                ],
            );
            return;
        }
        setCopied(false);
        onClose();
    };

    return (
        <Sheet
            visible={codes !== null}
            onClose={close}
            title={t('mobile.security.codes_title', 'Your recovery codes')}
            subtitle={t('mobile.security.codes_subtitle', 'Shown once. Store them somewhere you can reach without this phone.')}
            footer={<Button label={t('automations.sharing.done', 'Done')} onPress={close} fullWidth />}
        >
            <View style={styles.body}>
                <Banner tone="warning">
                    {t('mobile.security.codes_banner', 'Each code works once. They are your only way in if you lose your authenticator.')}
                </Banner>
                <View style={styles.codes}>
                    {(codes ?? []).map((code) => (
                        <Text key={code} variant="code" selectable>
                            {code}
                        </Text>
                    ))}
                </View>
                <Button
                    label={copied ? t('common.copied_short', 'Copied') : t('mobile.security.codes_copy_all', 'Copy all codes')}
                    variant="secondary"
                    onPress={() => {
                        void Clipboard.setStringAsync((codes ?? []).join('\n'));
                        setCopied(true);
                        toast(t('mobile.security.codes_copied', 'Recovery codes copied'), 'success');
                    }}
                    fullWidth
                />
            </View>
        </Sheet>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { gap: theme.spacing.md },
        codes: {
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
            padding: theme.spacing.md,
            gap: theme.spacing.xs,
        },
    });
