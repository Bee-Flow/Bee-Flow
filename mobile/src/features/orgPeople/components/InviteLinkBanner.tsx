/**
 * The invitation was made but its e-mail did not go out: the web's "Share the
 * link manually" with its copy button, plus the phone's share sheet.
 */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, IconButton, Icon, Text, useToast } from '@/shared/ui';

export function InviteLinkBanner({ url, onDismiss }: { url: string; onDismiss: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();

    const copy = async () => {
        await Clipboard.setStringAsync(url);
        toast(t('mobile.orgPeople.link_copied', 'Link copied'), 'success');
    };
    const share = async () => {
        try {
            await Share.share({ message: url });
        } catch (error) {
            toast(describeError(error).message, 'error');
        }
    };

    return (
        <View style={styles.wrap}>
            <Banner
                tone="warning"
                action={
                    <IconButton
                        accessibilityLabel={t('common.close', 'Close')}
                        icon={<Icon name="X" size={16} />}
                        onPress={onDismiss}
                    />
                }
            >
                <View style={styles.body}>
                    <Text variant="caption">
                        {t(
                            'mobile.orgPeople.invite_mail_failed',
                            'Invitation created but email delivery failed. Share the link manually:',
                        )}
                    </Text>
                    <Text variant="code" tone="secondary" selectable numberOfLines={2}>
                        {url}
                    </Text>
                    <View style={styles.row}>
                        <Button
                            size="sm"
                            variant="secondary"
                            iconName="Copy"
                            label={t('mobile.orgPeople.copy_link', 'Copy invite link')}
                            onPress={() => void copy()}
                        />
                        <Button
                            size="sm"
                            variant="secondary"
                            iconName="Share2"
                            label={t('mobile.orgPeople.share', 'Share')}
                            onPress={() => void share()}
                        />
                    </View>
                </View>
            </Banner>
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        wrap: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        body: { gap: theme.spacing.sm },
        row: { flexDirection: 'row', gap: theme.spacing.sm },
    });
