/**
 * Encryption, stated as it is. The recovery key is shown exactly ONCE, when it
 * is minted: there is no HTTP route to reissue it (server/auth/encryption.js
 * exports `rotateRecoveryKey`, but nothing mounts it), so this group does not
 * offer a button that cannot work. The algorithms are a line in the footer:
 * worth stating for whoever audits it, not worth a row each.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import * as vault from '@/core/auth/vault';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, InfoRow, NoteRow, Text } from '@/shared/ui';

export function EncryptionGroup() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { user } = useAuth();
    const unlocked = Boolean(vault.getDek());
    const signIn = user?.provider === 'local' ? 'OPAQUE' : t('mobile.security.sso', 'single sign-on');
    const footer = [
        t('mobile.security.encryption_footer', 'Your data is encrypted with a key only you can unlock. Nobody at Bee Flow, and no administrator, can read your content.'),
        t('mobile.security.technical_details', 'Technical details: AES-256-GCM with Argon2id key wrapping; sign-in by {signIn}.', { signIn }),
    ].join('\n\n');
    return (
        <Group title={t('settings.encryption', 'Encryption')} footer={footer}>
            <InfoRow
                label={t('mobile.security.content_encryption', 'Your content')}
                value={unlocked ? t('mobile.security.unlocked', 'Unlocked') : t('mobile.security.locked', 'Locked')}
                tone={unlocked ? 'success' : 'tertiary'}
            />
            <NoteRow>
                <View style={styles.note}>
                    <Text variant="body">{t('mobile.security.recovery_key', 'Your recovery key')}</Text>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.security.recovery_key_note', 'It was shown once, when your encryption was set up, and cannot be shown again or reissued. If you have lost it, you can still change your password while you are signed in.')}
                    </Text>
                </View>
            </NoteRow>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { gap: theme.spacing.xs },
    });
